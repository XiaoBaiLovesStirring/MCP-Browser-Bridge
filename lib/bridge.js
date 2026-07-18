// lib/bridge.js
// Bridge between the extension and the native messaging host.
//
// The native host (host.py) is a thin I/O proxy: it owns the HTTP/SSE server
// socket and forwards raw NDJSON frames to the extension over native messaging.
// All MCP protocol parsing happens here in the extension (self-contained),
// satisfying the "built-in protocol parsing" + "fast transfer" requirements:
// the native host never inspects or transforms the payload.

import { McpServer, textContent, errorContent, makeNotification, frameNewline } from "./mcp-protocol.js";

// Name must match the native messaging manifest's "name" field.
const NATIVE_HOST_NAME = "com.mcpbrowser.bridge";

/**
 * Bridge owns:
 *  - the native messaging Port to host.py
 *  - the McpServer instance with all tools/resources registered
 *  - per-client session state for SSE streams
 */
export class Bridge {
  constructor() {
    this.port = null;            // chrome.runtime.Port to native host
    this.server = null;          // McpServer
    this.connected = false;
    this._clients = new Map();   // clientId -> { transport, queue, sseAlive }
    this._onStatus = null;
  }

  onStatus(cb) { this._onStatus = cb; }

  _emitStatus(state, detail) {
    if (this._onStatus) this._onStatus({ state, detail, ts: Date.now() });
  }

  /** Attempt to connect to the native host. Resolves when handshake completes. */
  async connect() {
    if (this.connected && this.port) return true;
    try {
      this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      this._emitStatus("error", `connect failed: ${e.message}`);
      return false;
    }

    this.connected = true;
    this._emitStatus("connected", "native host connected");

    this.port.onMessage.addListener((msg) => this._onNativeMessage(msg));
    this.port.onDisconnect.addListener(() => {
      this.connected = false;
      this.port = null;
      this._emitStatus("disconnected", "native host disconnected");
    });

    return true;
  }

  /** Disconnect from the native host. */
  disconnect() {
    if (this.port) {
      try { this.port.disconnect(); } catch (_) {}
      this.port = null;
    }
    this.connected = false;
    this._emitStatus("disconnected", "manual disconnect");
  }

  /**
   * Messages from the native host are control envelopes:
   *   { type: "client_connect", clientId, transport }
   *   { type: "client_disconnect", clientId }
   *   { type: "request", clientId, payload }   // payload is decoded JSON-RPC
   *   { type: "config", serverPort, host, transport }
   */
  _onNativeMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "client_connect":
        this._clients.set(msg.clientId, { transport: msg.transport, queue: [], sseAlive: msg.transport === "sse" });
        break;
      case "client_disconnect":
        this._clients.delete(msg.clientId);
        break;
      case "request":
        this._handleRequest(msg.clientId, msg.payload).catch((e) => {
          this._sendToHost({ type: "response", clientId: msg.clientId, payload: errorContent(`handler crash: ${e.message}`) });
        });
        break;
      case "config":
        this._emitStatus("config", msg);
        break;
      case "pong":
        this._emitStatus("pong", msg);
        break;
      default:
        // Unknown control message; ignore.
        break;
    }
  }

  async _handleRequest(clientId, payload) {
    if (!this.server) {
      this._sendToHost({ type: "response", clientId, payload: { jsonrpc: "2.0", id: null, error: { code: -32603, message: "server not initialized" } } });
      return;
    }
    const ctx = { clientId };
    const response = await this.server.handleMessage(payload, ctx);
    if (response) {
      this._sendToHost({ type: "response", clientId, payload: response });
    }
  }

  /** Send a control envelope + optional JSON-RPC payload to the native host. */
  _sendToHost(envelope) {
    if (!this.port) return;
    try {
      this.port.postMessage(envelope);
    } catch (e) {
      this._emitStatus("error", `send failed: ${e.message}`);
    }
  }

  /** Push a notification (server -> client) over an existing SSE stream. */
  pushNotification(clientId, method, params) {
    const notif = makeNotification(method, params);
    this._sendToHost({ type: "notification", clientId, payload: notif });
  }

  /** Register the MCP server implementation. */
  setServer(server) {
    this.server = server;
  }

  /** Reconfigure the native host server (port/transport). */
  reconfigure({ host, port, transport }) {
    this._sendToHost({ type: "reconfigure", host, port, transport });
  }

  isReady() {
    return this.connected && !!this.server;
  }
}
