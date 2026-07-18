// background/background.js
// Service worker for MCP-Browser-Bridge.
// Owns the McpServer instance and routes MCP JSON-RPC requests from:
//   1. Internal callers (popup, options, MCP console) via chrome.runtime.onMessage
//   2. External web pages / MCP clients via chrome.runtime.onMessageExternal
//      (enabled by manifest's externally_connectable)
//   3. Desktop MCP clients via the Node.js native host (127.0.0.1:7777),
//      bridged through chrome.runtime.connectNative -> lib/bridge.js
// The native host is the only way to expose a real TCP port to local MCP
// clients from an MV3 extension. The host is pure Node.js (no Python).

import { McpServer, textContent, errorContent } from "../lib/mcp-protocol.js";
import { loadEngines, enabledEngines, findEngine } from "../lib/search-engines.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import {
  runSearch, fetchPage, extractCurrentTab,
  evalJsInTab, evalJsOnUrl, evalJsCurrent, listTabs,
} from "../lib/search-runner.js";
import bridge from "../lib/bridge.js";

const SERVER_INFO = { name: "mcp-browser-bridge", version: "0.6.0" };

let server = null;
let extensionId = null;
let bridgeStatus = { connected: false, hostInfo: null, error: null, attempts: 0 };

function buildServer() {
  const s = new McpServer(SERVER_INFO);

  s.registerTool("list_engines", {
    description: "List configured search engines (only enabled ones by default).",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: { type: "boolean", default: false },
      },
    },
  }, async (args) => {
    const engines = await loadEngines();
    const list = args && args.includeDisabled ? engines : enabledEngines(engines);
    return textContent(JSON.stringify(list.map((e) => ({
      id: e.id, name: e.name, enabled: e.enabled, urlTemplate: e.urlTemplate,
    })), null, 2));
  });

  s.registerTool("search", {
    description: "Run a web search using a configured engine. Opens a background tab, extracts results (title/url/snippet), closes the tab.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        engine: { type: "string", description: "Engine id. Defaults to first enabled engine." },
      },
      required: ["query"],
    },
  }, async (args) => {
    if (!args || !args.query) return errorContent("query is required");
    const settings = await loadSettings();
    const engines = await loadEngines();
    let engine = args.engine ? findEngine(engines, args.engine) : null;
    if (!engine) {
      const en = enabledEngines(engines);
      if (en.length === 0) return errorContent("no enabled search engine");
      engine = en[0];
    }
    try {
      const data = await runSearch(engine, args.query, settings);
      return textContent(JSON.stringify(data, null, 2));
    } catch (e) {
      return errorContent(`search failed: ${e.message}`);
    }
  });

  s.registerTool("fetch_page", {
    description: "Open a URL in a background tab, extract page text and all links, close the tab.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  }, async (args) => {
    if (!args || !args.url) return errorContent("url is required");
    const settings = await loadSettings();
    try {
      const data = await fetchPage(args.url, settings);
      return textContent(JSON.stringify(data, null, 2));
    } catch (e) {
      return errorContent(`fetch failed: ${e.message}`);
    }
  });

  s.registerTool("get_current_page", {
    description: "Extract text and links from the currently active tab. No new tab is opened.",
    inputSchema: { type: "object", properties: {} },
  }, async () => {
    const settings = await loadSettings();
    try {
      const data = await extractCurrentTab(settings);
      return textContent(JSON.stringify(data, null, 2));
    } catch (e) {
      return errorContent(`extraction failed: ${e.message}`);
    }
  });

  s.registerTool("list_tabs", {
    description: "List all open browser tabs (id, url, title, active). Use to pick a target for eval_js_tab.",
    inputSchema: {
      type: "object",
      properties: {
        currentWindowOnly: { type: "boolean", default: false },
      },
    },
  }, async (args) => {
    const tabs = args && args.currentWindowOnly
      ? await chrome.tabs.query({ currentWindow: true })
      : await listTabs();
    return textContent(JSON.stringify(tabs, null, 2));
  });

  s.registerTool("eval_js", {
    description: "Open a URL in a new background tab, wait for load, execute arbitrary JavaScript, return the result, close the tab. Lets AI operate the page: click, fill forms, read SPA-rendered DOM, parse page JS state.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        code: { type: "string", description: "Async function body. May use await. Last expression's resolved value is returned." },
        world: { type: "string", enum: ["ISOLATED", "MAIN"], default: "ISOLATED" },
      },
      required: ["url", "code"],
    },
  }, async (args) => {
    if (!args || !args.url) return errorContent("url is required");
    if (!args || !args.code) return errorContent("code is required");
    const settings = await loadSettings();
    try {
      const result = await evalJsOnUrl(args.url, args.code, settings, { world: args.world });
      return textContent(JSON.stringify(result, null, 2));
    } catch (e) {
      return errorContent(`eval_js failed: ${e.message}`);
    }
  });

  s.registerTool("eval_js_current", {
    description: "Execute arbitrary JavaScript in the currently active tab. No new tab is opened.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        world: { type: "string", enum: ["ISOLATED", "MAIN"], default: "ISOLATED" },
      },
      required: ["code"],
    },
  }, async (args) => {
    if (!args || !args.code) return errorContent("code is required");
    try {
      const result = await evalJsCurrent(args.code, { world: args.world });
      return textContent(JSON.stringify(result, null, 2));
    } catch (e) {
      return errorContent(`eval_js_current failed: ${e.message}`);
    }
  });

  s.registerTool("eval_js_tab", {
    description: "Execute arbitrary JavaScript in a specific open tab by id (from list_tabs).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer" },
        code: { type: "string" },
        world: { type: "string", enum: ["ISOLATED", "MAIN"], default: "ISOLATED" },
      },
      required: ["tabId", "code"],
    },
  }, async (args) => {
    if (!args || args.tabId === undefined || args.tabId === null) return errorContent("tabId is required");
    if (!args || !args.code) return errorContent("code is required");
    try {
      const result = await evalJsInTab(Number(args.tabId), args.code, { world: args.world });
      return textContent(JSON.stringify(result, null, 2));
    } catch (e) {
      return errorContent(`eval_js_tab failed: ${e.message}`);
    }
  });

  s.registerTool("bridge_status", {
    description: "Return the status of the native host bridge (Node.js process listening on 127.0.0.1:7777). Shows whether desktop MCP clients can reach the extension over HTTP/SSE.",
    inputSchema: { type: "object", properties: {} },
  }, async () => {
    const settings = await loadSettings();
    return textContent(JSON.stringify({
      connected: bridge.isReady(),
      hostInfo: bridge.getHostInfo(),
      bridgeStatus,
      configured: { host: settings.host, port: settings.port, transport: settings.transport, hostEnabled: settings.hostEnabled },
      endpoints: bridge.getHostInfo() ? {
        streamableHttp: `http://${bridge.getHostInfo().host}:${bridge.getHostInfo().port}/mcp`,
        sse: `http://${bridge.getHostInfo().host}:${bridge.getHostInfo().port}/sse`,
        health: `http://${bridge.getHostInfo().host}:${bridge.getHostInfo().port}/health`,
      } : null,
    }, null, 2));
  });

  s.registerTool("extension_status", {
    description: "Return extension status: version, tool count, configured engines, current settings, bridge status.",
    inputSchema: { type: "object", properties: {} },
  }, async () => {
    const settings = await loadSettings();
    const engines = await loadEngines();
    return textContent(JSON.stringify({
      active: true,
      version: SERVER_INFO.version,
      extensionId,
      toolCount: s.listTools().length,
      tools: s.listTools().map((t) => t.name),
      enabledEngines: enabledEngines(engines).map((e) => e.id),
      settings: {
        tabLifecycle: settings.tabLifecycle,
        pageLoadTimeoutMs: settings.pageLoadTimeoutMs,
        maxResults: settings.maxResults,
        host: settings.host,
        port: settings.port,
        transport: settings.transport,
        hostEnabled: settings.hostEnabled,
      },
      bridge: {
        connected: bridge.isReady(),
        hostInfo: bridge.getHostInfo(),
        error: bridgeStatus.error,
        reconnectAttempts: bridgeStatus.attempts,
      },
    }, null, 2));
  });

  s.registerResource("mcpbb://engines", {
    description: "Configured search engines (JSON).",
    mimeType: "application/json",
  }, async () => {
    const engines = await loadEngines();
    return { contents: [{ uri: "mcpbb://engines", mimeType: "application/json", text: JSON.stringify(engines) }] };
  });

  return s;
}

server = buildServer();
extensionId = chrome.runtime.id;

/** Handle an MCP JSON-RPC payload. Returns the JSON-RPC response (or null for notifications). */
async function handleMcpPayload(payload) {
  return await server.handleMessage(payload, {});
}

// --------------------------------------------------------------------------- //
// Native host bridge
// --------------------------------------------------------------------------- //
//
// When the host receives an HTTP/SSE MCP request from a desktop client, it
// sends { type: "request", clientId, payload } over native messaging. We
// dispatch the payload to the MCP server and ship the response back.

bridge.onStatusChange((status) => {
  bridgeStatus = {
    connected: status.connected,
    hostInfo: status.hostInfo,
    error: status.error,
    attempts: status.attempts,
  };
  console.log(`[mcp-browser-bridge] bridge status: connected=${status.connected} attempts=${status.attempts} error=${status.error || ""}`);
});

bridge.onRequest(async (clientId, payload) => {
  // payload is a JSON-RPC 2.0 message. The McpServer returns the response
  // object (or null for notifications). Forward it back to the host tagged
  // with the same clientId so it can be routed to the right HTTP session.
  const response = await handleMcpPayload(payload);
  if (response !== null) {
    bridge.sendResponse(clientId, response);
  }
  // For notifications (response === null), nothing to send.
  return null; // we already called sendResponse ourselves
});

// Announce ourselves to the host as soon as it becomes ready. The host logs
// this; the tool list is for debugging/visibility.
bridge.onStatusChange((status) => {
  if (status.connected) {
    bridge.announceBridgeReady(SERVER_INFO.version, server.listTools().map((t) => t.name));
  }
});

// Auto-connect on startup if hostEnabled.
(async () => {
  const settings = await loadSettings();
  if (settings.hostEnabled) {
    bridge.connect();
  }
})();

// --------------------------------------------------------------------------- //
// Internal messages (popup / options / MCP console)
// --------------------------------------------------------------------------- //
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false, error: "missing type" });
      return;
    }
    switch (msg.type) {
      case "mcp-request": {
        // Internal MCP invocation: { type: "mcp-request", payload: <json-rpc> }
        try {
          const response = await handleMcpPayload(msg.payload);
          sendResponse({ ok: true, response });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
      case "list-tools": {
        sendResponse({ ok: true, tools: server.listTools() });
        break;
      }
      case "get-status": {
        const settings = await loadSettings();
        sendResponse({
          ok: true,
          active: true,
          version: SERVER_INFO.version,
          extensionId,
          toolCount: server.listTools().length,
          settings,
          bridge: bridgeStatus,
        });
        break;
      }
      case "apply-settings": {
        const next = await saveSettings(msg.settings || {});
        sendResponse({ ok: true, settings: next });
        break;
      }
      case "bridge-reconnect": {
        bridge.connect();
        sendResponse({ ok: true });
        break;
      }
      case "bridge-disconnect": {
        bridge.disconnect();
        sendResponse({ ok: true });
        break;
      }
      case "bridge-get-status": {
        sendResponse({ ok: true, status: bridgeStatus, ready: bridge.isReady(), hostInfo: bridge.getHostInfo() });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // async
});

// --------------------------------------------------------------------------- //
// External messages (web pages / MCP clients via externally_connectable)
// --------------------------------------------------------------------------- //
// Protocol: a web page calls
//   chrome.runtime.sendMessage(EXTENSION_ID, { type: "mcp", payload: <json-rpc> }, callback)
// and receives { ok: true, response: <json-rpc> } (or { ok: true, accepted: true } for notifications).
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || msg.type !== "mcp") {
      sendResponse({ ok: false, error: "expected { type: 'mcp', payload: <json-rpc> }" });
      return;
    }
    try {
      const response = await handleMcpPayload(msg.payload);
      if (response === null) {
        // Notification (no id): acknowledge, no JSON-RPC body.
        sendResponse({ ok: true, accepted: true });
      } else {
        sendResponse({ ok: true, response });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async
});

// Mark the service worker as ready.
console.log(`[mcp-browser-bridge] service worker ready, extensionId=${extensionId}`);
