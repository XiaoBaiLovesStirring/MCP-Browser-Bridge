#!/usr/bin/env node
// native-host/host.mjs
// MCP-Browser-Bridge native messaging host (Node.js, single file, zero npm deps).
//
// Bridges desktop MCP clients (HTTP / SSE on 127.0.0.1:7777) to the Chrome
// extension via Chrome Native Messaging (stdio with 4-byte LE length prefix).
//
// Pure Node.js built-in modules only: http, crypto, process.
// No Python. No npm install. Just run: node host.mjs
//
// Transport support (universal MCP client compatibility):
//   - MCP 2025-06-18 Streamable HTTP  : POST /mcp, GET /mcp, DELETE /mcp
//   - MCP 2024-11-05 legacy SSE       : GET /sse, POST /messages?sessionId=...
//
// The extension is the actual MCP server (registers tools, handles JSON-RPC).
// This host is just a transport adapter: HTTP client -> stdin -> extension ->
// stdout -> HTTP response.

import http from "node:http";
import crypto from "node:crypto";

// --------------------------------------------------------------------------- //
// Configuration
// --------------------------------------------------------------------------- //

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const PORT = Number(process.env.MCPBB_PORT) || DEFAULT_PORT;

// Each MCP session has a random id and holds pending JSON-RPC responses keyed
// by jsonrpc id, plus a long-lived SSE response stream (for legacy SSE).
const sessions = new Map(); // sessionId -> { sseRes, pending: Map<id, {resolve,reject}>, streamInit: bool }

// Pending JSON-RPC requests sent to the extension but not yet answered,
// keyed by `${sessionId}:${jsonrpcId}`. Value is { resolve, reject, timer }.
const inflight = new Map();

// --------------------------------------------------------------------------- //
// Native messaging I/O (stdio)
// --------------------------------------------------------------------------- //
//
// Chrome native messaging protocol:
//   - stdin  : Chrome -> host. 4-byte LE length prefix + UTF-8 JSON.
//   - stdout : host -> Chrome. Same framing.
//   - stderr : free-form, captured by Chrome for debugging logs.

let stdinBuf = Buffer.alloc(0);

function sendToExtension(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function logToStderr(msg) {
  process.stderr.write(`[mcpbb-host] ${msg}\n`);
}

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const json = stdinBuf.subarray(4, 4 + len);
    stdinBuf = stdinBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(json.toString("utf8"));
    } catch (e) {
      logToStderr(`invalid JSON from extension: ${e.message}`);
      continue;
    }
    handleExtensionMessage(msg).catch((e) => {
      logToStderr(`handleExtensionMessage error: ${e && e.message ? e.message : String(e)}`);
    });
  }
});

process.stdin.on("end", () => {
  logToStderr("stdin ended (Chrome disconnected). Shutting down.");
  shutdown(0);
});

// --------------------------------------------------------------------------- //
// Routing: messages coming back from the extension
// --------------------------------------------------------------------------- //
//
// The extension sends messages of the form:
//   { type: "response", clientId, payload: <json-rpc response> }
//   { type: "notification", clientId, payload: <json-rpc notification> }
//   { type: "bridge_ready", version, tools }
//   { type: "bridge_error", error }
//
// `clientId` is the MCP session id we assigned when forwarding the request.
// For Streamable HTTP, we resolve the pending inflight promise.
// For legacy SSE, we also write the response/notification to the SSE stream.

async function handleExtensionMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "response": {
      const { clientId, payload } = msg;
      deliverToSession(clientId, payload, /*isResponse=*/ true);
      break;
    }
    case "notification": {
      const { clientId, payload } = msg;
      deliverToSession(clientId, payload, /*isResponse=*/ false);
      break;
    }
    case "bridge_ready":
      logToStderr(`bridge ready: version=${msg.version} tools=${(msg.tools || []).length}`);
      break;
    case "bridge_error":
      logToStderr(`bridge error: ${msg.error}`);
      break;
    default:
      // Unknown: ignore silently.
      break;
  }
}

function deliverToSession(sessionId, payload, isResponse) {
  const session = sessions.get(sessionId);
  if (!session) {
    // Session already closed. Drop.
    return;
  }

  // Streamable HTTP: resolve inflight request by jsonrpc id.
  if (isResponse && payload && payload.id !== undefined && payload.id !== null) {
    const key = `${sessionId}:${payload.id}`;
    const entry = inflight.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      inflight.delete(key);
      entry.resolve(payload);
    }
  }

  // Legacy SSE: also push the raw JSON-RPC message to the long-lived stream.
  if (session.sseRes && !session.sseRes.writableEnded) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    session.sseRes.write(data);
    session.lastEventId = payload.id;
  }

  // If it was a response with an id and no SSE client is attached, the inflight
  // promise above already handled it. If there's no inflight (e.g. server-initiated
  // notification or a response we didn't track), and there's no SSE stream, just drop.
}

// --------------------------------------------------------------------------- //
// HTTP server: MCP 2025-06-18 Streamable HTTP + legacy SSE
// --------------------------------------------------------------------------- //

function newSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

function ensureSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { sseRes: null, lastEventId: null, pending: new Map(), streamInit: false });
  }
  return sessions.get(id);
}

function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.sseRes && !s.sseRes.writableEnded) {
    try { s.sseRes.end(); } catch (_) {}
  }
  // Reject any pending inflight requests on this session.
  for (const [key, entry] of inflight.entries()) {
    if (key.startsWith(`${id}:`)) {
      clearTimeout(entry.timer);
      entry.reject(new Error("session closed"));
      inflight.delete(key);
    }
  }
  sessions.delete(id);
}

// Forward a JSON-RPC payload to the extension tagged with the session id.
function forwardToExtension(sessionId, payload) {
  sendToExtension({ type: "request", clientId: sessionId, payload });
}

const server = http.createServer((req, res) => {
  // CORS: allow any local MCP client to call us.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // ----------------------------------------------------------------------- //
  // Health / info endpoint
  // ----------------------------------------------------------------------- //
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "mcp-browser-bridge",
      version: "0.6.0",
      transport: ["streamable-http", "sse"],
      endpoints: {
        streamableHttp: "/mcp",
        sse: "/sse",
        messages: "/messages",
      },
    }));
    return;
  }

  // ----------------------------------------------------------------------- //
  // MCP 2025-06-18 Streamable HTTP: /mcp
  // ----------------------------------------------------------------------- //
  if (path === "/mcp") {
    handleStreamableHttp(req, res, url);
    return;
  }

  // ----------------------------------------------------------------------- //
  // MCP 2024-11-05 legacy SSE: /sse  +  /messages
  // ----------------------------------------------------------------------- //
  if (path === "/sse") {
    handleLegacySseHandshake(req, res, url);
    return;
  }
  if (path === "/messages") {
    handleLegacyMessages(req, res, url);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path }));
});

// --------------------------------------------------------------------------- //
// Streamable HTTP (2025-06-18)
// --------------------------------------------------------------------------- //
//
//   POST   /mcp  - client -> server JSON-RPC request/notification
//   GET    /mcp  - open a streaming response channel (server -> client)
//   DELETE /mcp  - terminate the session

function handleStreamableHttp(req, res, url) {
  const accept = req.headers["accept"] || "";
  const sessionHeader = req.headers["mcp-session-id"];

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }

      // Assign or reuse a session.
      const sessionId = sessionHeader || newSessionId();
      ensureSession(sessionId);

      // Notifications (no id): forward, acknowledge with 202.
      if (payload && (payload.id === undefined || payload.id === null)) {
        forwardToExtension(sessionId, payload);
        res.writeHead(202, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Request (has id): forward, wait for response, return it inline.
      const key = `${sessionId}:${payload.id}`;
      const timer = setTimeout(() => {
        const entry = inflight.get(key);
        if (entry) {
          inflight.delete(key);
          entry.reject(new Error("timeout waiting for extension response"));
        }
      }, 5 * 60 * 1000); // 5 min timeout

      inflight.set(key, {
        resolve: (response) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify(response));
        },
        reject: (err) => {
          res.writeHead(500, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err.message || "internal error" },
            id: payload.id,
          }));
        },
        timer,
      });

      forwardToExtension(sessionId, payload);
    });
    req.on("error", (e) => {
      logToStderr(`POST /mcp request error: ${e.message}`);
      try { res.writeHead(400); res.end(); } catch (_) {}
    });
    return;
  }

  if (req.method === "GET") {
    // Open a streaming response channel. The client uses Accept: text/event-stream.
    if (!accept.includes("text/event-stream")) {
      res.writeHead(406, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GET /mcp requires Accept: text/event-stream" }));
      return;
    }
    const sessionId = sessionHeader || newSessionId();
    const session = ensureSession(sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Mcp-Session-Id": sessionId,
    });
    // Keep the stream open; server-initiated notifications will be pushed here.
    // We don't yet expose server-initiated notifications from the extension, but
    // the channel is ready if/when we add them.
    res.write(`event: endpoint\ndata: ${JSON.stringify("/mcp")}\n\n`);
    // Note: we intentionally do NOT attach this as session.sseRes because the
    // Streamable HTTP model resolves each POST inline. This GET channel is for
    // server-initiated notifications only (rare). Keep a reference so we can
    // close it on session destroy.
    session.streamRes = res;
    req.on("close", () => {
      if (session.streamRes === res) session.streamRes = null;
    });
    return;
  }

  if (req.method === "DELETE") {
    const sessionId = sessionHeader;
    if (sessionId) destroySession(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "method not allowed" }));
}

// --------------------------------------------------------------------------- //
// Legacy SSE (2024-11-05)
// --------------------------------------------------------------------------- //
//
//   GET  /sse                         - open SSE stream, receive endpoint URI
//   POST /messages?sessionId=...      - send JSON-RPC to the server

function handleLegacySseHandshake(req, res, url) {
  // In the legacy protocol, the session id is chosen by the server and
  // embedded in the endpoint URI returned on the SSE stream.
  const sessionId = newSessionId();
  const session = ensureSession(sessionId);
  session.sseRes = res;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const endpointUri = `/messages?sessionId=${sessionId}`;
  res.write(`event: endpoint\ndata: ${JSON.stringify(endpointUri)}\n\n`);

  // Heartbeat every 25s to keep proxies from closing the connection.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch (_) {}
  }, 25000);
  session.heartbeat = heartbeat;

  req.on("close", () => {
    clearInterval(heartbeat);
    if (session.sseRes === res) session.sseRes = null;
    // Note: we do not destroy the session here; the client may reconnect.
    // The session will be reaped if unused.
  });
}

function handleLegacyMessages(req, res, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing sessionId query parameter" }));
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown session" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    // In the legacy SSE protocol, POST /messages is acknowledged with 202 and
    // the actual JSON-RPC response is delivered via the SSE stream.
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    forwardToExtension(sessionId, payload);
  });
  req.on("error", (e) => {
    logToStderr(`POST /messages request error: ${e.message}`);
    try { res.writeHead(400); res.end(); } catch (_) {}
  });
}

// --------------------------------------------------------------------------- //
// Startup / shutdown
// --------------------------------------------------------------------------- //

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logToStderr(`port ${PORT} is already in use. Set MCPBB_PORT to override.`);
  } else {
    logToStderr(`http server error: ${err.message}`);
  }
  shutdown(1);
});

server.listen(PORT, HOST, () => {
  logToStderr(`MCP-Browser-Bridge native host listening on http://${HOST}:${PORT}`);
  logToStderr(`  Streamable HTTP : http://${HOST}:${PORT}/mcp`);
  logToStderr(`  Legacy SSE      : http://${HOST}:${PORT}/sse`);
  logToStderr(`  Health          : http://${HOST}:${PORT}/health`);
  // Announce to the extension that the host is up.
  sendToExtension({ type: "host_ready", host: HOST, port: PORT, version: "0.6.0" });
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { server.close(); } catch (_) {}
  for (const id of [...sessions.keys()]) destroySession(id);
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (e) => {
  logToStderr(`uncaughtException: ${e && e.stack ? e.stack : String(e)}`);
});
process.on("unhandledRejection", (e) => {
  logToStderr(`unhandledRejection: ${e && e.message ? e.message : String(e)}`);
});
