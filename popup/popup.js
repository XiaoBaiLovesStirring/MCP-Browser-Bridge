// popup/popup.js
// Toolbar popup for MCP-Browser-Bridge.
// Shows extension status, quick search test, and language switcher.

import { initLang, t, applyTranslations, bindLangSwitch } from "../lib/i18n.js";
import { STRINGS } from "../lib/strings.js";

const $ = (sel) => document.getElementById(sel);

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "get-status" });
    if (r && r.ok) {
      $("statusText").textContent = `${t("pop.active")} \u00b7 ${r.toolCount} ${t("pop.tools")}`;
      $("meta").textContent = `v${r.version} \u00b7 ${r.extensionId ? r.extensionId.slice(0, 16) + "\u2026" : ""}`;
    }
  } catch (e) {
    $("statusText").textContent = "Error: " + e.message;
  }
}

async function quickSearch() {
  const query = $("searchInput").value.trim();
  if (!query) return;
  const output = $("output");
  output.hidden = false;
  output.textContent = "Searching\u2026";
  try {
    const r = await chrome.runtime.sendMessage({
      type: "mcp-request",
      payload: {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "search", arguments: { query } },
      },
    });
    if (r && r.ok && r.response) {
      const result = r.response.result && r.response.result.content
        ? r.response.result.content[0].text
        : JSON.stringify(r.response, null, 2);
      output.textContent = result;
    } else {
      output.textContent = "Error: " + (r && r.error ? r.error : "unknown");
    }
  } catch (e) {
    output.textContent = "Error: " + e.message;
  }
}

function bindEvents() {
  bindLangSwitch();
  $("searchBtn").addEventListener("click", quickSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") quickSearch();
  });
  $("openOptionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("openConsoleBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("mcp/mcp.html") }));
}

(async () => {
  await initLang(STRINGS);
  bindEvents();
  applyTranslations();
  refresh();
})();