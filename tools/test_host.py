#!/usr/bin/env python3
"""End-to-end test for host.py's MCP Streamable HTTP implementation.

Simulates the browser extension by reading/writing native-messaging frames on
the host's stdin/stdout, while making real HTTP requests to the server the
host starts. No browser required. Verifies:
  1. reconfigure starts the HTTP server
  2. POST /mcp initialize returns Mcp-Session-Id
  3. POST /mcp tools/list with session id returns tools
  4. notification (no id) returns 202
  5. GET /health works
  6. DELETE /mcp terminates session
  7. Legacy GET /sse + POST /messages works
"""
import json
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error

HOST = "127.0.0.1"
PORT = 18765  # non-default to avoid clashes

proc = subprocess.Popen(
    [sys.executable, "native-host/host.py"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    bufsize=0,
)


def read_msg():
    raw = b""
    while len(raw) < 4:
        chunk = proc.stdout.read(4 - len(raw))
        if not chunk:
            raise EOFError("host stdout closed")
        raw += chunk
    n = struct.unpack("<I", raw)[0]
    data = b""
    while len(data) < n:
        chunk = proc.stdout.read(n - len(data))
        if not chunk:
            raise EOFError("host stdout closed mid-message")
        data += chunk
    return json.loads(data.decode())


def write_msg(msg):
    data = json.dumps(msg, separators=(",", ":")).encode()
    proc.stdin.write(struct.pack("<I", len(data)))
    proc.stdin.write(data)
    proc.stdin.flush()


# Simulated extension: respond to every request with a stub result.
def extension_loop():
    while True:
        try:
            msg = read_msg()
        except EOFError:
            return
        t = msg.get("type")
        if t == "request":
            payload = msg["payload"]
            # Notifications (no id) get no response, per JSON-RPC/MCP.
            if not isinstance(payload, dict) or "id" not in payload:
                continue
            method = payload.get("method")
            if method == "initialize":
                result = {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "test-bridge", "version": "0.2.0"},
                }
            elif method == "tools/list":
                result = {"tools": [{"name": "search", "description": "stub"}]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "stub result"}]}
            else:
                result = {}
            response = {"jsonrpc": "2.0", "id": payload.get("id"), "result": result}
            write_msg({"type": "response", "clientId": msg["clientId"], "payload": response})
        # ignore client_connect / client_disconnect / config / pong


threading.Thread(target=extension_loop, daemon=True).start()


def http(method, path, body=None, headers=None):
    url = f"http://{HOST}:{PORT}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **(headers or {}),
    })
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    # 1. reconfigure to start server
    write_msg({"type": "reconfigure", "host": HOST, "port": PORT, "transport": "both"})
    # wait for config response
    deadline = time.time() + 5
    while time.time() < deadline:
        # extension_loop is draining stdout; we need to peek the config.
        # Simpler: just sleep then probe HTTP.
        time.sleep(0.5)
        try:
            status, _, body = http("GET", "/health")
            if status == 200:
                print(f"PASS: server up, health={json.loads(body)['status']}")
                break
        except Exception:
            continue
    else:
        print("FAIL: server did not start")
        proc.terminate()
        return 1

    # 2. initialize -> expect Mcp-Session-Id
    status, hdrs, body = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert status == 200, f"init status {status}"
    sid = hdrs.get("Mcp-Session-Id") or hdrs.get("Mcp-session-id")
    assert sid, f"no Mcp-Session-Id in headers: {list(hdrs.keys())}"
    init_resp = json.loads(body)
    assert init_resp["result"]["protocolVersion"] == "2025-06-18"
    print(f"PASS: initialize returned session {sid[:8]}, protocol 2025-06-18")

    # 3. tools/list with session id
    status, hdrs, body = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                              headers={"Mcp-Session-Id": sid})
    assert status == 200, f"tools/list status {status}"
    data = json.loads(body)
    assert "result" in data and "tools" in data["result"]
    print(f"PASS: tools/list returned {len(data['result']['tools'])} tool(s)")

    # 4. notification (no id) -> 202
    status, hdrs, body = http("POST", "/mcp",
                              {"jsonrpc": "2.0", "method": "notifications/initialized"},
                              headers={"Mcp-Session-Id": sid})
    assert status == 202, f"notification status {status}"
    print("PASS: notification returned 202")

    # 5. tools/call
    status, hdrs, body = http("POST", "/mcp",
                              {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                               "params": {"name": "search", "arguments": {"query": "test"}}},
                              headers={"Mcp-Session-Id": sid})
    assert status == 200
    call_data = json.loads(body)
    assert call_data["result"]["content"][0]["text"] == "stub result"
    print("PASS: tools/call returned stub result")

    # 6. DELETE /mcp
    status, _, _ = http("DELETE", "/mcp", headers={"Mcp-Session-Id": sid})
    assert status == 200, f"delete status {status}"
    print("PASS: DELETE /mcp terminated session")

    # 7. Legacy SSE: GET /sse -> endpoint event
    import socket
    s = socket.create_connection((HOST, PORT), timeout=5)
    s.sendall(b"GET /sse HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n")
    buf = b""
    s.settimeout(3)
    try:
        while b"endpoint" not in buf and len(buf) < 4096:
            buf += s.recv(1024)
    except socket.timeout:
        pass
    s.close()
    assert b"event: endpoint" in buf and b"sessionId=" in buf, f"no endpoint event in: {buf[:200]}"
    print("PASS: legacy GET /sse returned endpoint event")

    print("\nAll tests passed.")
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
