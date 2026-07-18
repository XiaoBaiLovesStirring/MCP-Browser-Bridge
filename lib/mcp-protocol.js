// lib/mcp-protocol.js
// Built-in MCP (Model Context Protocol) parser.
// Implements JSON-RPC 2.0 framing + MCP message types.
// Pure, dependency-free, and fast: no intermediate allocations on the hot path.

export const MCP_VERSION = "2024-11-05";

// JSON-RPC error codes
export const ERR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// Capability negotiation constants
export const CAPABILITIES = {
  server: { tools: {}, resources: {}, prompts: {} },
};

/**
 * Encode a JSON-RPC response/error object to a Uint8Array (UTF-8).
 * Avoids double serialization by writing directly.
 */
export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  return new TextEncoder().encode(json);
}

/** Decode a Uint8Array/string buffer into a JSON-RPC object. Throws on invalid JSON. */
export function decodeMessage(buf) {
  const text = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
  return JSON.parse(text);
}

/** Build a JSON-RPC error response. */
export function makeError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

/** Build a JSON-RPC success response. */
export function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC notification (no id). */
export function makeNotification(method, params) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/**
 * Frame a complete message for HTTP transport (newline-delimited JSON).
 * Returns a Uint8Array ending with \n.
 */
export function frameNewline(obj) {
  const json = JSON.stringify(obj);
  const enc = new TextEncoder();
  const body = enc.encode(json);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  out[body.length] = 0x0a; // \n
  return out;
}

/**
 * Streaming newline-delimited JSON parser.
 * Feed it chunks; it emits complete messages via onMessage callback.
 * Minimal state, zero-copy over the line buffer where possible.
 */
export class NDJsonStream {
  constructor(onMessage, onError) {
    this._buf = "";
    this._onMessage = onMessage;
    this._onError = onError;
  }

  /** Feed a chunk (string or Uint8Array). */
  push(chunk) {
    if (chunk && chunk instanceof Uint8Array) {
      this._buf += new TextDecoder().decode(chunk);
    } else if (typeof chunk === "string") {
      this._buf += chunk;
    } else if (chunk) {
      this._buf += String(chunk);
    }

    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      try {
        this._onMessage(JSON.parse(line));
      } catch (e) {
        if (this._onError) this._onError(e, line);
      }
    }
  }
}

/**
 * High-level MCP server protocol handler.
 * Routes incoming JSON-RPC requests to registered handlers.
 * Implements: initialize, ping, tools/list, tools/call, resources/list,
 * resources/read, prompts/list, prompts/get, notifications/initialized.
 */
export class McpServer {
  constructor(serverInfo) {
    this.serverInfo = serverInfo;
    this._tools = new Map();        // name -> { description, inputSchema, handler }
    this._resources = new Map();    // uri -> { description, mimeType, handler }
    this._prompts = new Map();      // name -> { description, arguments, handler }
    this._initialized = false;
  }

  /** Register a tool. handler: (args, ctx) => Promise<result> */
  registerTool(name, { description, inputSchema, handler }) {
    this._tools.set(name, { description, inputSchema: inputSchema ?? {}, handler });
  }

  /** Register a resource. handler: (uri, ctx) => Promise<{contents}> */
  registerResource(uri, { description, mimeType, handler }) {
    this._resources.set(uri, { description, mimeType: mimeType ?? "text/plain", handler });
  }

  /** Register a prompt. handler: (args, ctx) => Promise<{messages}> */
  registerPrompt(name, { description, arguments: argDefs, handler }) {
    this._prompts.set(name, { description, arguments: argDefs ?? [], handler });
  }

  listTools() {
    return Array.from(this._tools.entries()).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Handle a single decoded JSON-RPC message.
   * Returns the response object to send back, or null for notifications.
   * ctx is an opaque object passed to tool/resource handlers (e.g. caller id).
   */
  async handleMessage(msg, ctx) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return makeError(msg && msg.id, ERR_CODES.INVALID_REQUEST, "Invalid Request");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize": {
          const result = {
            protocolVersion: MCP_VERSION,
            capabilities: CAPABILITIES.server,
            serverInfo: this.serverInfo,
          };
          return isNotification ? null : makeResult(id, result);
        }
        case "notifications/initialized": {
          this._initialized = true;
          return null; // notification, no response
        }
        case "ping": {
          return isNotification ? null : makeResult(id, {});
        }
        case "tools/list": {
          return isNotification ? null : makeResult(id, { tools: this.listTools() });
        }
        case "tools/call": {
          const { name, arguments: args } = params || {};
          const tool = this._tools.get(name);
          if (!tool) {
            return isNotification ? null : makeError(id, ERR_CODES.INVALID_PARAMS, `Unknown tool: ${name}`);
          }
          const result = await tool.handler(args || {}, ctx);
          return isNotification ? null : makeResult(id, result);
        }
        case "resources/list": {
          const resources = Array.from(this._resources.entries()).map(([uri, r]) => ({
            uri, description: r.description, mimeType: r.mimeType,
          }));
          return isNotification ? null : makeResult(id, { resources });
        }
        case "resources/read": {
          const { uri } = params || {};
          const r = this._resources.get(uri);
          if (!r) {
            return isNotification ? null : makeError(id, ERR_CODES.INVALID_PARAMS, `Unknown resource: ${uri}`);
          }
          const result = await r.handler(uri, ctx);
          return isNotification ? null : makeResult(id, result);
        }
        case "prompts/list": {
          const prompts = Array.from(this._prompts.entries()).map(([name, p]) => ({
            name, description: p.description, arguments: p.arguments,
          }));
          return isNotification ? null : makeResult(id, { prompts });
        }
        case "prompts/get": {
          const { name, arguments: args } = params || {};
          const p = this._prompts.get(name);
          if (!p) {
            return isNotification ? null : makeError(id, ERR_CODES.INVALID_PARAMS, `Unknown prompt: ${name}`);
          }
          const result = await p.handler(args || {}, ctx);
          return isNotification ? null : makeResult(id, result);
        }
        default:
          return isNotification ? null : makeError(id, ERR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (e) {
      return isNotification ? null : makeError(
        id, ERR_CODES.INTERNAL_ERROR,
        e && e.message ? e.message : "Internal error",
        { stack: e && e.stack }
      );
    }
  }
}

/**
 * Build a standard MCP tool-call result from text.
 * content: array of { type, text | ... }
 */
export function textContent(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

/** Build a tool-call result that signals an error to the model without throwing. */
export function errorContent(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}
