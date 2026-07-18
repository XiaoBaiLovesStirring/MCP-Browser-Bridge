// background/background.js
// Service worker: wires up the MCP server, the native-host bridge, and the
// search/page-extraction pipeline. Exposes status + control to popup/options.

import { McpServer, textContent, errorContent } from "../lib/mcp-protocol.js";
import { Bridge } from "../lib/bridge.js";
import { loadEngines, enabledEngines, findEngine } from "../lib/search-engines.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import {
  runSearch, fetchPage, extractCurrentTab,
  evalJsInTab, evalJsOnUrl, evalJsCurrent, listTabs,
} from "../lib/search-runner.js";

const SERVER_INFO = { name: "mcp-browser-bridge", version: "0.2.0" };

let bridge = null;
let statusCache = { state: "init", detail: "starting", ts: Date.now() };

/** Build the MCP server with all tools/resources registered. */
function buildServer() {
  const server = new McpServer(SERVER_INFO);

  // --- Tool: list_engines ---
  server.registerTool("list_engines", {
    description: "List configured search engines (only enabled ones by default).",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: { type: "boolean", default: false, description: "Include disabled engines in the list." },
      },
    },
  }, async (args) => {
    const engines = await loadEngines();
    const list = args && args.includeDisabled ? engines : enabledEngines(engines);
    return textContent(JSON.stringify(list.map((e) => ({
      id: e.id, name: e.name, enabled: e.enabled, urlTemplate: e.urlTemplate,
    })), null, 2));
  });

  // --- Tool: search ---
  server.registerTool("search", {
    description: "Run a web search using a configured search engine. Opens a new background tab, extracts results, and returns them. Each result has title, url, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        engine: { type: "string", description: "Engine id (e.g. google). Defaults to the first enabled engine." },
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

  // --- Tool: fetch_page ---
  server.registerTool("fetch_page", {
    description: "Open a URL in a background tab, extract the page text and all links, and return them. Useful for reading a page discovered via search.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute URL to fetch." },
      },
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

  // --- Tool: get_current_page ---
  server.registerTool("get_current_page", {
    description: "Extract text and links from the currently active tab in the user's browser. No new tab is opened.",
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

  // --- Tool: bridge_status ---
  server.registerTool("bridge_status", {
    description: "Return the current status of the MCP-Browser-Bridge (native host connection, configured port, transport).",
    inputSchema: { type: "object", properties: {} },
  }, async () => {
    const settings = await loadSettings();
    return textContent(JSON.stringify({
      connected: bridge ? bridge.isReady() : false,
      status: statusCache,
      settings: { port: settings.port, transport: settings.transport, host: settings.host },
    }, null, 2));
  });

  // --- Tool: list_tabs ---
  server.registerTool("list_tabs", {
    description: "List all open browser tabs (id, url, title, active). Use this to pick a target tab for eval_js_tab.",
    inputSchema: {
      type: "object",
      properties: {
        currentWindowOnly: { type: "boolean", default: false, description: "Only list tabs in the current window." },
      },
    },
  }, async (args) => {
    let tabs;
    if (args && args.currentWindowOnly) {
      tabs = await chrome.tabs.query({ currentWindow: true });
    } else {
      tabs = await listTabs();
    }
    return textContent(JSON.stringify(tabs, null, 2));
  });

  // --- Tool: eval_js ---
  server.registerTool("eval_js", {
    description: "Open a URL in a new background tab, wait for it to load, then execute arbitrary JavaScript in the page and return the result. This lets you operate the page as a real user would: click buttons, fill forms, read SPA-rendered DOM, scrape dynamic content, etc. The tab is closed afterwards unless tabLifecycle is 'keep'.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to open in the new tab." },
        code: { type: "string", description: "JavaScript code to run. Treated as the body of an async function: you may use `await`, and the last expression's resolved value is returned. Examples: `return document.title;` or `const btn = document.querySelector('button'); btn.click(); await new Promise(r => setTimeout(r, 500)); return document.body.innerText;`" },
        world: { type: "string", enum: ["ISOLATED", "MAIN"], default: "ISOLATED", description: "ISOLATED (default): runs in the extension's isolated world, safe from page CSP, full DOM access but cannot read page JS globals. MAIN: runs in the page's main world, can read/modify page JS variables and SPA framework state (React/Vue/jQuery), but subject to the page's CSP." },
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

  // --- Tool: eval_js_current ---
  server.registerTool("eval_js_current", {
    description: "Execute arbitrary JavaScript in the currently active browser tab (the page the user is looking at). No new tab is opened; the page stays open. Use this to operate on or parse the page the user is currently viewing.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to run (async function body). See eval_js for details." },
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

  // --- Tool: eval_js_tab ---
  server.registerTool("eval_js_tab", {
    description: "Execute arbitrary JavaScript in a specific open tab by its id (use list_tabs to discover tab ids). Lets you operate on or parse any already-open page without opening a new one.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "The target tab id (from list_tabs)." },
        code: { type: "string", description: "JavaScript code to run (async function body). See eval_js for details." },
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

  // --- Resource: engine list ---
  server.registerResource("mcpbb://engines", {
    description: "Configured search engines (JSON).",
    mimeType: "application/json",
  }, async () => {
    const engines = await loadEngines();
    return { contents: [{ uri: "mcpbb://engines", mimeType: "application/json", text: JSON.stringify(engines) }] };
  });

  return server;
}

/** Initialize the bridge and connect to the native host. */
async function initBridge() {
  if (!bridge) {
    bridge = new Bridge();
    bridge.onStatus((s) => { statusCache = s; });
    bridge.setServer(buildServer());
  }
  const settings = await loadSettings();
  if (settings.autoStart) {
    await bridge.connect();
    // Tell the host which port/transport to serve.
    bridge.reconfigure({ host: settings.host, port: settings.port, transport: settings.transport });
  }
}

// --- Lifecycle hooks ---
chrome.runtime.onInstalled.addListener(async () => {
  await initBridge();
});

chrome.runtime.onStartup.addListener(async () => {
  await initBridge();
});

// Also try to init when the service worker wakes for the first time
// (covers the case where the browser was already running with the extension).
initBridge().catch((e) => {
  statusCache = { state: "error", detail: `init failed: ${e.message}`, ts: Date.now() };
});

// --- Message API for options/popup pages ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "get-status": {
        sendResponse({ ok: true, status: statusCache, connected: bridge ? bridge.isReady() : false });
        break;
      }
      case "reconnect": {
        if (!bridge) { bridge = new Bridge(); bridge.onStatus((s) => { statusCache = s; }); bridge.setServer(buildServer()); }
        await bridge.connect();
        const s = await loadSettings();
        bridge.reconfigure({ host: s.host, port: s.port, transport: s.transport });
        sendResponse({ ok: true, status: statusCache });
        break;
      }
      case "disconnect": {
        if (bridge) bridge.disconnect();
        sendResponse({ ok: true, status: statusCache });
        break;
      }
      case "apply-settings": {
        const next = await saveSettings(msg.settings || {});
        if (bridge && bridge.isReady()) {
          bridge.reconfigure({ host: next.host, port: next.port, transport: next.transport });
        }
        sendResponse({ ok: true, settings: next });
        break;
      }
      case "get-settings": {
        const s = await loadSettings();
        sendResponse({ ok: true, settings: s });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // async
});
