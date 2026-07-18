// background/background.js
// Service worker for the pure browser extension.
// Owns the McpServer instance and routes MCP JSON-RPC requests from:
//   1. Internal callers (popup, options, MCP console) via chrome.runtime.onMessage
//   2. External web pages / MCP clients via chrome.runtime.onMessageExternal
//      (enabled by manifest's externally_connectable)
// No native messaging, no Python host, no external dependencies.

import { McpServer, textContent, errorContent } from "../lib/mcp-protocol.js";
import { loadEngines, enabledEngines, findEngine } from "../lib/search-engines.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import {
  runSearch, fetchPage, extractCurrentTab,
  evalJsInTab, evalJsOnUrl, evalJsCurrent, listTabs,
} from "../lib/search-runner.js";

const SERVER_INFO = { name: "mcp-browser-bridge", version: "0.3.0" };

let server = null;
let extensionId = null;

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

  s.registerTool("extension_status", {
    description: "Return extension status: version, tool count, configured engines, current settings.",
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

// --- Internal messages (popup / options / MCP console) ---
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
        });
        break;
      }
      case "apply-settings": {
        const next = await saveSettings(msg.settings || {});
        sendResponse({ ok: true, settings: next });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // async
});

// --- External messages (web pages / MCP clients via externally_connectable) ---
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
