// lib/bridge.js
// Native messaging client between the Chrome extension and the Node.js host.
//
// The Node host (native-host/host.mjs) listens on http://127.0.0.1:7777 and
// exposes MCP Streamable HTTP + legacy SSE to desktop MCP clients. When a
// request arrives, the host forwards it to the extension over Chrome Native
// Messaging (chrome.runtime.connectNative). This module owns that connection,
// routes incoming requests to the MCP server, and ships responses back.
//
// Wire format (extension <-> host), all JSON over native messaging stdio:
//   host -> extension : { type: "host_ready", host, port, version }
//                       { type: "request",     clientId, payload: <json-rpc> }
//   extension -> host  : { type: "bridge_ready", version, tools }
//                       { type: "response",    clientId, payload: <json-rpc response> }
//                       { type: "notification", clientId, payload: <json-rpc notification> }
//                       { type: "bridge_error", error }

const HOST_NAME = "com.mcpbrowser.bridge";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

class Bridge {
  constructor() {
    this.port = null;
    this.connected = false;
    this.hostInfo = null;        // { host, port, version } once host_ready received
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manualDisconnect = false;

    this.requestHandlers = [];   // callbacks: (clientId, payload) => Promise<response|null>
    this.statusListeners = [];   // callbacks: (status) => void
  }

  /** Connect (or reconnect) to the native host. Idempotent. */
  connect() {
    if (this.port) return;
    this.manualDisconnect = false;
    try {
      this.port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      this._onDisconnect(`connectNative threw: ${e && e.message ? e.message : String(e)}`);
      return;
    }

    this.port.onMessage.addListener((msg) => this._onMessage(msg));
    this.port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      this._onDisconnect(err && err.message ? err.message : "native port disconnected");
    });

    // The connection object exists immediately, but we only mark "connected"
    // once we receive host_ready from the host. That guarantees the HTTP server
    // is up and the port is actually wired end-to-end.
  }

  /** Manually disconnect. Will not auto-reconnect until connect() is called. */
  disconnect() {
    this.manualDisconnect = true;
    this._clearReconnect();
    if (this.port) {
      try { this.port.disconnect(); } catch (_) {}
      this.port = null;
    }
    this._setStatus(false);
  }

  /** True once host_ready has been received. */
  isReady() {
    return this.connected && !!this.hostInfo;
  }

  /** Current host info: { host, port, version } or null. */
  getHostInfo() {
    return this.hostInfo;
  }

  /** Register a handler for incoming MCP requests. */
  onRequest(fn) {
    this.requestHandlers.push(fn);
  }

  /** Register a status listener: fn({ connected, hostInfo, error, attempts }). */
  onStatusChange(fn) {
    this.statusListeners.push(fn);
    // Fire immediately with current state.
    fn(this._statusSnapshot());
  }

  /** Send a JSON-RPC response back to the host (for the given client). */
  sendResponse(clientId, payload) {
    this._send({ type: "response", clientId, payload });
  }

  /** Send a JSON-RPC notification back to the host (server -> client). */
  sendNotification(clientId, payload) {
    this._send({ type: "notification", clientId, payload });
  }

  /** Announce bridge readiness + tool list to the host. */
  announceBridgeReady(version, tools) {
    this._send({ type: "bridge_ready", version, tools: tools || [] });
  }

  // ----------------------------------------------------------------------- //
  // Internals
  // ----------------------------------------------------------------------- //

  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "host_ready": {
        this.hostInfo = { host: msg.host, port: msg.port, version: msg.version };
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastError = null;
        this._setStatus(true);
        break;
      }
      case "request": {
        // Forward to request handlers. The first handler that returns a
        // non-null value wins (typically there is only one, set by the
        // background script).
        const { clientId, payload } = msg;
        this._dispatchRequest(clientId, payload);
        break;
      }
      default:
        // Unknown: ignore.
        break;
    }
  }

  async _dispatchRequest(clientId, payload) {
    let response = null;
    for (const fn of this.requestHandlers) {
      try {
        const r = await fn(clientId, payload);
        if (r !== undefined && r !== null) {
          response = r;
          break;
        }
      } catch (e) {
        // If the handler threw, synthesize a JSON-RPC error response so the
        // HTTP client gets a proper error rather than a hang.
        response = {
          jsonrpc: "2.0",
          error: { code: -32603, message: e && e.message ? e.message : String(e) },
          id: payload && payload.id !== undefined ? payload.id : null,
        };
        break;
      }
    }
    if (response !== null) {
      this.sendResponse(clientId, response);
    }
    // If response is null (e.g. notification with no id), nothing to send.
  }

  _onDisconnect(reason) {
    this.port = null;
    this.connected = false;
    this.lastError = reason || "disconnected";
    if (this.hostInfo) {
      // Keep last-known hostInfo for display, but mark not connected.
    }
    this._setStatus(false);

    if (this.manualDisconnect) return;
    // Schedule a reconnect with exponential backoff.
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _send(obj) {
    if (!this.port) return;
    try {
      this.port.postMessage(obj);
    } catch (e) {
      // Port may have died. Treat as disconnect.
      this._onDisconnect(`postMessage failed: ${e && e.message ? e.message : String(e)}`);
    }
  }

  _statusSnapshot() {
    return {
      connected: this.connected,
      hostInfo: this.hostInfo,
      error: this.lastError,
      attempts: this.reconnectAttempts,
      manualDisconnect: this.manualDisconnect,
    };
  }

  _setStatus(connected) {
    const snap = this._statusSnapshot();
    for (const fn of this.statusListeners) {
      try { fn(snap); } catch (_) {}
    }
  }
}

export const bridge = new Bridge();
export default bridge;
