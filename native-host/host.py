#!/usr/bin/env python3
"""
MCP-Browser-Bridge native messaging host.

Role: a thin, fast I/O proxy between MCP clients and the browser extension.
Owns the local HTTP/SSE server socket and forwards raw JSON-RPC frames to the
extension over Chrome native messaging (stdio). All MCP protocol parsing
happens inside the extension; this host only does transport-layer routing
(session management, request/response correlation).

Transport support (compatible with ALL MCP clients — Claude Desktop, Cursor,
Cline, Windsurf, Continue, etc.):
  - Streamable HTTP (MCP 2025-06-18, recommended):
      POST   /mcp            - send JSON-RPC; response as JSON or SSE stream
      GET    /mcp            - open SSE stream for server->client notifications
      DELETE /mcp            - terminate session
  - Legacy SSE (MCP 2024-11-05, for older clients):
      GET    /sse            - open SSE stream; first event gives POST endpoint
      POST   /messages       - send JSON-RPC; response via SSE stream
  - Health:
      GET    /health         - server status

Session management:
  - On `initialize` POST, the host mints a session id and returns it in the
    Mcp-Session-Id response header (per spec).
  - Subsequent requests should echo Mcp-Session-Id; if missing, the host
    creates an ephemeral session (lenient, for maximal client compatibility).
  - Sessions expire after 1 hour of inactivity (reaper thread).

Native messaging wire format (Chrome spec):
  stdin/stdout: <uint32 little-endian length><utf-8 json bytes>

Zero external dependencies: standard library only.
"""
import sys
import json
import struct
import threading
import queue
import uuid
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST_NAME = "com.mcpbrowser.bridge"
SESSION_TTL_SECONDS = 3600  # 1 hour idle timeout

# CORS: MCP clients may run in different origins (Electron apps, web UIs, etc.).
CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"),
    ("Access-Control-Allow-Headers",
     "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Authorization"),
    ("Access-Control-Expose-Headers", "Mcp-Session-Id"),
    ("Access-Control-Max-Age", "86400"),
]


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
    if n <= 0 or n > 64 * 1024 * 1024:
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
            pass


# --------------------------------------------------------------------------- #
# Session
# --------------------------------------------------------------------------- #
class Session:
    """One MCP client session. Bridges a network transport to a single
    extension client_id (which equals the session_id)."""
    __slots__ = ("session_id", "transport", "response_queue", "subscribers",
                 "last_activity", "alive", "lock")

    def __init__(self, session_id, transport):
        self.session_id = session_id
        self.transport = transport  # "streamable" | "sse-legacy"
        self.response_queue = queue.Queue()  # responses for POST /mcp to consume
        self.subscribers = []  # list of queue.Queue for GET streams (SSE)
        self.last_activity = time.time()
        self.alive = True
        self.lock = threading.Lock()

    def touch(self):
        self.last_activity = time.time()

    def push_response(self, payload):
        """A JSON-RPC response from the extension. POST /mcp consumes it via
        response_queue; GET streams also receive it via subscribers."""
        self.response_queue.put(payload)
        self.broadcast(payload)

    def broadcast(self, payload):
        """A server->client notification from the extension. Push to all GET streams."""
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            q.put(payload)

    def add_subscriber(self):
        q = queue.Queue()
        with self.lock:
            self.subscribers.append(q)
        return q

    def remove_subscriber(self, q):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def wake_all_subscribers(self):
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            q.put(None)  # sentinel: session closed


# --------------------------------------------------------------------------- #
# Bridge host
# --------------------------------------------------------------------------- #
class BridgeHost:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self.server = None
        self.server_thread = None
        self.config = {"host": "127.0.0.1", "port": 8765, "transport": "both"}
        self.running = True
        self._reaper = threading.Thread(target=self._reap_sessions, daemon=True)
        self._reaper.start()

    # --- session registry ---
    def create_session(self, transport):
        sid = str(uuid.uuid4())
        sess = Session(sid, transport)
        with self.lock:
            self.sessions[sid] = sess
        write_message({"type": "client_connect", "clientId": sid, "transport": transport})
        return sess

    def get_session(self, sid):
        if not sid:
            return None
        with self.lock:
            return self.sessions.get(sid)

    def close_session(self, sid):
        with self.lock:
            sess = self.sessions.pop(sid, None)
        if not sess:
            return
        sess.alive = False
        sess.wake_all_subscribers()
        write_message({"type": "client_disconnect", "clientId": sid})

    def _reap_sessions(self):
        """Background thread: expire idle sessions."""
        while self.running:
            time.sleep(60)
            now = time.time()
            to_close = []
            with self.lock:
                for sid, sess in self.sessions.items():
                    if not sess.alive or (now - sess.last_activity) > SESSION_TTL_SECONDS:
                        to_close.append(sid)
            for sid in to_close:
                _log(f"[host] expiring idle session {sid[:8]}\n")
                self.close_session(sid)

    # --- extension message handling ---
    def handle_extension_message(self, msg):
        t = msg.get("type")
        if t == "reconfigure":
            self.reconfigure(msg)
        elif t == "response":
            self._route(msg.get("clientId"), msg.get("payload"), is_response=True)
        elif t == "notification":
            self._route(msg.get("clientId"), msg.get("payload"), is_response=False)
        elif t == "ping":
            write_message({"type": "pong", "ts": int(time.time() * 1000)})
        # unknown types: ignore

    def _route(self, client_id, payload, is_response):
        if not client_id:
            return
        sess = self.get_session(client_id)
        if not sess:
            return
        if is_response:
            sess.push_response(payload)
        else:
            sess.broadcast(payload)

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
        write_message({"type": "config", **new_cfg, "started": ok})

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
    server_version = "MCPBrowserBridge/0.2"

    def log_message(self, *args):
        pass

    @property
    def bridge(self):
        return self.server.bridge

    @property
    def transport_mode(self):
        return self.bridge.config.get("transport", "both")

    def _transport_allows(self, kind):
        """kind: 'streamable' | 'sse-legacy'. Returns True if current config allows it."""
        t = self.transport_mode
        if t == "both":
            return True
        if t == "streamable":
            return kind == "streamable"
        if t == "sse":
            return kind == "sse-legacy"
        return True

    # ----- CORS -----
    def _send_cors(self):
        for k, v in CORS_HEADERS:
            self.send_header(k, v)

    # ----- body parsing -----
    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length > 0 else b""
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    # ----- OPTIONS (CORS preflight) -----
    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----- GET -----
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            self._send_health()
            return
        if path == "/sse":
            if self._transport_allows("sse-legacy"):
                self._handle_legacy_sse()
            else:
                self.send_error(404, "Legacy SSE not enabled")
            return
        if path == "/mcp":
            if self._transport_allows("streamable"):
                self._handle_streamable_get()
            else:
                self.send_error(404, "Streamable HTTP not enabled")
            return
        self.send_error(404)

    # ----- POST -----
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json_body()
        except Exception:
            self._send_json_error(400, "invalid json body")
            return
        if path == "/mcp":
            if self._transport_allows("streamable"):
                self._handle_streamable_post(payload)
            else:
                self.send_error(404, "Streamable HTTP not enabled")
            return
        if path == "/messages":
            if self._transport_allows("sse-legacy"):
                self._handle_legacy_messages(payload)
            else:
                self.send_error(404, "Legacy SSE not enabled")
            return
        self.send_error(404)

    # ----- DELETE -----
    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/mcp":
            self._handle_streamable_delete()
            return
        self.send_error(404)

    # ----- health -----
    def _send_health(self):
        body = {
            "status": "ok",
            "name": HOST_NAME,
            "version": "0.2.0",
            "transport": self.transport_mode,
            "endpoint": f"http://{self.bridge.config['host']}:{self.bridge.config['port']}",
            "sessions": len(self.bridge.sessions),
            "endpoints": ["/mcp (POST/GET/DELETE)", "/sse (GET)", "/messages (POST)", "/health (GET)"],
        }
        data = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ----- Streamable HTTP: POST /mcp -----
    def _handle_streamable_post(self, payload):
        session_id = self.headers.get("Mcp-Session-Id")
        accept = self.headers.get("Accept", "") or ""
        accept_sse = "text/event-stream" in accept
        accept_json = ("application/json" in accept) or ("*/*" in accept) or (not accept_sse)

        if not isinstance(payload, dict):
            self._send_json_error(400, "payload must be a JSON-RPC object")
            return

        method = payload.get("method")
        has_id = "id" in payload
        is_notification_or_response = not has_id

        # Session resolution
        if method == "initialize":
            # Always mint a fresh session for initialize.
            sess = self.bridge.create_session("streamable")
            session_id = sess.session_id
        else:
            if not session_id:
                # Lenient: create an ephemeral session for clients that don't
                # send the header (e.g. simple curl tests, some older clients).
                sess = self.bridge.create_session("streamable")
                session_id = sess.session_id
            else:
                sess = self.bridge.get_session(session_id)
                if not sess:
                    self._send_json_error(404, "session not found or expired")
                    return
        sess.touch()

        # Notification / response (no id) -> 202 Accepted, no body.
        # Still forward to extension so it can track state (e.g. notifications/initialized).
        if is_notification_or_response:
            write_message({"type": "request", "clientId": session_id, "payload": payload})
            self._send_accepted(session_id)
            return

        # Request (has id) -> forward and wait for response.
        write_message({"type": "request", "clientId": session_id, "payload": payload})
        try:
            response = sess.response_queue.get(timeout=60)
        except queue.Empty:
            response = {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {"code": -32603, "message": "timeout waiting for extension"},
            }

        # Choose response format based on Accept header (spec: client must list both).
        if accept_sse and not accept_json:
            self._send_sse_stream([response], session_id)
        else:
            self._send_json_response(response, session_id)

    # ----- Streamable HTTP: GET /mcp (server->client notifications) -----
    def _handle_streamable_get(self):
        session_id = self.headers.get("Mcp-Session-Id")
        if not session_id:
            self._send_json_error(400, "Mcp-Session-Id header required for GET /mcp")
            return
        sess = self.bridge.get_session(session_id)
        if not sess:
            self._send_json_error(404, "session not found")
            return
        sess.touch()

        sub_q = sess.add_subscriber()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Mcp-Session-Id", session_id)
        self._send_cors()
        self.end_headers()

        last_ping = time.time()
        try:
            while sess.alive and self.bridge.running:
                try:
                    notif = sub_q.get(timeout=15)
                    if notif is None:
                        break  # session closed
                    data = json.dumps(notif, separators=(",", ":"))
                    safe = data.replace("\n", "\ndata: ")
                    self.wfile.write(f"data: {safe}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    now = time.time()
                    if now - last_ping >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
        except Exception:
            pass
        finally:
            sess.remove_subscriber(sub_q)

    # ----- Streamable HTTP: DELETE /mcp -----
    def _handle_streamable_delete(self):
        session_id = self.headers.get("Mcp-Session-Id")
        if session_id:
            self.bridge.close_session(session_id)
        self.send_response(200)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----- Legacy SSE: GET /sse -----
    def _handle_legacy_sse(self):
        sess = self.bridge.create_session("sse-legacy")
        session_id = sess.session_id
        sub_q = sess.add_subscriber()

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self._send_cors()
        self.end_headers()

        # First event: tell client where to POST subsequent requests.
        endpoint = f"/messages?sessionId={session_id}"
        try:
            self.wfile.write(f"event: endpoint\ndata: {endpoint}\n\n".encode("utf-8"))
            self.wfile.flush()
        except Exception:
            self.bridge.close_session(session_id)
            return

        last_ping = time.time()
        try:
            while sess.alive and self.bridge.running:
                try:
                    msg = sub_q.get(timeout=15)
                    if msg is None:
                        break
                    data = json.dumps(msg, separators=(",", ":"))
                    safe = data.replace("\n", "\ndata: ")
                    self.wfile.write(f"data: {safe}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    now = time.time()
                    if now - last_ping >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
        except Exception:
            pass
        finally:
            sess.remove_subscriber(sub_q)
            self.bridge.close_session(session_id)

    # ----- Legacy SSE: POST /messages -----
    def _handle_legacy_messages(self, payload):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        session_id = qs.get("sessionId", [None])[0]
        sess = self.bridge.get_session(session_id) if session_id else None
        if not sess:
            # No active SSE stream; fall back to synchronous handling.
            self._handle_stateless_post(payload)
            return
        sess.touch()
        # Forward to extension; the JSON-RPC response (if any) will be pushed
        # back over the GET /sse stream.
        write_message({"type": "request", "clientId": session_id, "payload": payload})
        # 202 Accepted: receipt acknowledged; actual response (if any) via SSE.
        self.send_response(202)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----- Stateless fallback (no SSE session, no streamable session) -----
    def _handle_stateless_post(self, payload):
        """One-shot synchronous JSON-RPC over HTTP (no session streaming)."""
        if not isinstance(payload, dict):
            self._send_json_error(400, "payload must be a JSON-RPC object")
            return
        has_id = "id" in payload
        sess = self.bridge.create_session("streamable")
        session_id = sess.session_id
        write_message({"type": "request", "clientId": session_id, "payload": payload})

        if not has_id:
            # Notification -> 202, no body.
            self.bridge.close_session(session_id)
            self.send_response(202)
            self._send_cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        try:
            response = sess.response_queue.get(timeout=60)
        except queue.Empty:
            response = {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {"code": -32603, "message": "timeout waiting for extension"},
            }
        self.bridge.close_session(session_id)
        self._send_json_response(response, session_id)

    # ----- response senders -----
    def _send_json_response(self, obj, session_id=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_sse_stream(self, messages, session_id=None):
        """Send a finite SSE stream containing `messages` then close."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self._send_cors()
        self.end_headers()
        for msg in messages:
            data = json.dumps(msg, separators=(",", ":"))
            safe = data.replace("\n", "\ndata: ")
            self.wfile.write(f"data: {safe}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _send_accepted(self, session_id=None):
        self.send_response(202)
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json_error(self, status, message):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main():
    _log("[host] MCP-Browser-Bridge native host starting (v0.2)\n")
    host = BridgeHost()
    host.run()
    _log("[host] native host exiting\n")


if __name__ == "__main__":
    main()
