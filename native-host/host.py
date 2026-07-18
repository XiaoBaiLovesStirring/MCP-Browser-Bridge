#!/usr/bin/env python3
"""
MCP-Browser-Bridge native messaging host.

Role: a thin, fast I/O proxy between MCP clients (Claude Desktop, etc.) and
the browser extension. It owns the local HTTP/SSE server socket and forwards
raw JSON-RPC frames to the extension over Chrome native messaging (stdio).
All MCP protocol parsing happens inside the extension; this host never
inspects or transforms payloads, which keeps latency minimal.

Transport:
  - SSE:   GET  /sse                       -> event stream (response + endpoint event)
           POST /messages?sessionId=<id>    -> send JSON-RPC, response via stream
  - HTTP:  POST /mcp                       -> single request/response (synchronous)
  - both:  both endpoints are served

Message flow:
  MCP client --HTTP/SSE--> host --native msg--> extension (parses + handles)
  extension --native msg--> host --HTTP/SSE--> MCP client

Native messaging wire format (Chrome spec):
  stdin/stdout messages are: <uint32 little-endian length><utf-8 json bytes>
"""
import sys
import os
import json
import struct
import threading
import queue
import uuid
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST_NAME = "com.mcpbrowser.bridge"


# --------------------------------------------------------------------------- #
# Native messaging I/O (thread-safe writes; single stdin reader)
# --------------------------------------------------------------------------- #
_write_lock = threading.Lock()


def _log(msg):
    """Safe stderr write (Windows pythonw has stderr=None)."""
    try:
        if sys.stderr is not None:
            sys.stderr.write(msg)
            sys.stderr.flush()
    except Exception:
        pass


def read_message():
    """Read one native messaging message from stdin. Returns dict or None on EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    n = struct.unpack("<I", raw_len)[0]
    if n <= 0 or n > 64 * 1024 * 1024:  # Chrome caps messages at 1 MB; be lenient
        return None
    data = b""
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    try:
        return json.loads(data.decode("utf-8"))
    except Exception as e:
        _log(f"[host] bad json from extension: {e}\n")
        return None


def write_message(msg):
    """Write one native messaging message to stdout (thread-safe)."""
    data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
    with _write_lock:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except Exception:
            # stdout closed (browser is shutting down); ignore.
            pass


# --------------------------------------------------------------------------- #
# Bridge state
# --------------------------------------------------------------------------- #
class Client:
    __slots__ = ("client_id", "transport", "queue", "alive")

    def __init__(self, client_id, transport):
        self.client_id = client_id
        self.transport = transport  # "sse" | "http"
        self.queue = queue.Queue()  # outgoing ("response"|"notification", payload)
        self.alive = True


class BridgeHost:
    def __init__(self):
        self.clients = {}
        self.lock = threading.Lock()
        self.server = None
        self.server_thread = None
        self.config = {"host": "127.0.0.1", "port": 8765, "transport": "sse"}
        self.running = True

    # --- client registry ---
    def add_client(self, client_id, transport):
        with self.lock:
            self.clients[client_id] = Client(client_id, transport)
            return self.clients[client_id]

    def get_client(self, client_id):
        with self.lock:
            return self.clients.get(client_id)

    def remove_client(self, client_id):
        with self.lock:
            self.clients.pop(client_id, None)

    # --- extension message handling ---
    def handle_extension_message(self, msg):
        t = msg.get("type")
        if t == "reconfigure":
            self.reconfigure(msg)
        elif t == "response":
            self._route(msg.get("clientId"), ("response", msg.get("payload")))
        elif t == "notification":
            self._route(msg.get("clientId"), ("notification", msg.get("payload")))
        elif t == "ping":
            write_message({"type": "pong", "ts": int(time.time() * 1000)})
        # unknown types: ignore

    def _route(self, client_id, item):
        if not client_id:
            return
        c = self.get_client(client_id)
        if c:
            c.queue.put(item)

    def reconfigure(self, msg):
        new_cfg = {
            "host": msg.get("host", self.config["host"]),
            "port": int(msg.get("port", self.config["port"])),
            "transport": msg.get("transport", self.config["transport"]),
        }
        same = (
            self.server is not None
            and new_cfg["host"] == self.config["host"]
            and new_cfg["port"] == self.config["port"]
            and new_cfg["transport"] == self.config["transport"]
        )
        if same:
            write_message({"type": "config", **new_cfg, "already_running": True})
            return
        self.config = new_cfg
        self.stop_server()
        ok = self.start_server()
        write_message({
            "type": "config",
            **new_cfg,
            "started": ok,
        })

    def start_server(self):
        host, port, transport = self.config["host"], self.config["port"], self.config["transport"]
        try:
            srv = BridgeServer((host, port), self)
            self.server = srv
            self.server_thread = threading.Thread(target=srv.serve_forever, daemon=True)
            self.server_thread.start()
            _log(f"[host] listening on {host}:{port} transport={transport}\n")
            return True
        except Exception as e:
            _log(f"[host] failed to start server: {e}\n")
            self.server = None
            return False

    def stop_server(self):
        if self.server is None:
            return
        try:
            # shutdown must be called from another thread to avoid deadlock
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            self.server.server_close()
        except Exception:
            pass
        self.server = None

    def run(self):
        """Main loop: read from extension stdin until EOF."""
        try:
            while self.running:
                msg = read_message()
                if msg is None:
                    break
                try:
                    self.handle_extension_message(msg)
                except Exception as e:
                    _log(f"[host] error handling message: {e}\n")
        finally:
            self.running = False
            self.stop_server()


# --------------------------------------------------------------------------- #
# HTTP/SSE server
# --------------------------------------------------------------------------- #
class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, bridge):
        super().__init__(server_address, Handler)
        self.bridge = bridge


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MCPBrowserBridge/0.1"

    # quieter logging
    def log_message(self, *args):
        pass

    @property
    def bridge(self):
        return self.server.bridge

    @property
    def transport_mode(self):
        return self.bridge.config.get("transport", "sse")

    # ----- helpers -----
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length > 0 else b""
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    # ----- GET -----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/health"):
            self.send_json({
                "status": "ok",
                "name": HOST_NAME,
                "transport": self.transport_mode,
                "endpoint": f"http://{self.bridge.config['host']}:{self.bridge.config['port']}",
            })
            return
        if path == "/sse":
            if self.transport_mode in ("sse", "both"):
                self.handle_sse()
            else:
                self.send_error(404, "SSE not enabled")
            return
        self.send_error(404)

    # ----- POST -----
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            payload = self.read_json_body()
        except Exception:
            self.send_error(400, "invalid json")
            return

        if path == "/messages" and self.transport_mode in ("sse", "both"):
            self.handle_sse_message(parsed, payload)
            return
        if path == "/mcp" and self.transport_mode in ("http", "both"):
            self.handle_http_message(payload)
            return
        # Fallback: accept /messages for http mode and /mcp for sse mode too,
        # to be forgiving with clients.
        if path in ("/mcp", "/messages"):
            qs = parse_qs(parsed.query)
            session_id = qs.get("sessionId", [None])[0]
            if session_id and self.bridge.get_client(session_id):
                self.handle_sse_message(parsed, payload)
            else:
                self.handle_http_message(payload)
            return
        self.send_error(404)

    # ----- SSE -----
    def handle_sse(self):
        client_id = "sse-" + uuid.uuid4().hex
        self.bridge.add_client(client_id, "sse")
        write_message({"type": "client_connect", "clientId": client_id, "transport": "sse"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # Tell the client where to POST subsequent requests.
        endpoint = f"/messages?sessionId={client_id}"
        try:
            self.wfile.write(f"event: endpoint\ndata: {endpoint}\n\n".encode("utf-8"))
            self.wfile.flush()
        except Exception:
            self._cleanup_sse(client_id)
            return

        client = self.bridge.get_client(client_id)
        last_ping = time.time()
        try:
            while self.bridge.running and client.alive:
                try:
                    kind, payload = client.queue.get(timeout=15)
                except queue.Empty:
                    # heartbeat
                    now = time.time()
                    if now - last_ping >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
                    continue
                data = json.dumps(payload, separators=(",", ":"))
                # SSE "data" lines must not contain raw newlines; split safely.
                safe = data.replace("\n", "\ndata: ")
                self.wfile.write(f"data: {safe}\n\n".encode("utf-8"))
                self.wfile.flush()
        except Exception:
            pass
        finally:
            self._cleanup_sse(client_id)

    def _cleanup_sse(self, client_id):
        self.bridge.remove_client(client_id)
        write_message({"type": "client_disconnect", "clientId": client_id})

    def handle_sse_message(self, parsed, payload):
        qs = parse_qs(parsed.query)
        session_id = qs.get("sessionId", [None])[0]
        client = self.bridge.get_client(session_id) if session_id else None
        if not client:
            # No active SSE session; fall back to synchronous HTTP response.
            self.handle_http_message(payload)
            return
        # Forward to extension; response will arrive over the SSE stream.
        write_message({"type": "request", "clientId": session_id, "payload": payload})
        # Acknowledge receipt. The actual JSON-RPC response is pushed via SSE.
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----- HTTP (synchronous) -----
    def handle_http_message(self, payload):
        client_id = "http-" + uuid.uuid4().hex
        self.bridge.add_client(client_id, "http")
        write_message({"type": "client_connect", "clientId": client_id, "transport": "http"})
        write_message({"type": "request", "clientId": client_id, "payload": payload})

        # Notifications have no id and expect no response.
        is_notification = isinstance(payload, dict) and "id" not in payload
        if is_notification:
            self.bridge.remove_client(client_id)
            write_message({"type": "client_disconnect", "clientId": client_id})
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        client = self.bridge.get_client(client_id)
        response = None
        try:
            kind, response = client.queue.get(timeout=30)
        except queue.Empty:
            response = {
                "jsonrpc": "2.0",
                "id": payload.get("id") if isinstance(payload, dict) else None,
                "error": {"code": -32603, "message": "timeout waiting for extension"},
            }
        finally:
            self.bridge.remove_client(client_id)
            write_message({"type": "client_disconnect", "clientId": client_id})

        self.send_json(response)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main():
    # On Windows, Chrome launches hosts without a console; stderr is harmless.
    # On Linux/macOS, stderr is discarded by Chrome but useful for manual runs.
    _log("[host] MCP-Browser-Bridge native host starting\n")
    host = BridgeHost()
    host.run()
    _log("[host] native host exiting\n")


if __name__ == "__main__":
    main()
