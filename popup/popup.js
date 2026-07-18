// popup/popup.js
import { STRINGS } from "../lib/strings.js";
import { initLang, t, applyTranslations, bindLangSwitch, getLang } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "get-status" });
    if (r && r.ok) {
      $("statusText").textContent = `${t("pop.active")} · ${r.toolCount} ${t("pop.tools")}`;
      $("meta").textContent = `v${r.version} · ${r.extensionId ? r.extensionId.slice(0, 16) + "…" : ""}`;
      // Bridge status line
      const line = $("bridgeLine");
      const dot = $("bridgeDot");
      const txt = $("bridgeText");
      const bridge = r.bridge;
      if (bridge) {
        line.hidden = false;
        if (bridge.connected) {
          dot.className = "bridge-dot on";
          txt.textContent = `${t("pop.bridgeOn")}${bridge.hostInfo ? ` (${bridge.hostInfo.host}:${bridge.hostInfo.port})` : ""}`;
        } else {
          dot.className = "bridge-dot off";
          txt.textContent = t("pop.bridgeOff");
        }
      } else {
        line.hidden = true;
      }
    }
  } catch (e) {
    $("statusText").textContent = "Error: " + e.message;
  }
}

$("consoleBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("mcp/mcp.html") }));
$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("searchBtn").addEventListener("click", async () => {
  const query = $("queryInput").value.trim();
  if (!query) return;
  const out = $("testOutput");
  out.hidden = false;
  out.textContent = "…";
  try {
    const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "search", arguments: { query } } };
    const r = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
    if (!r || !r.ok) { out.textContent = "Error: " + (r ? r.error : "no response"); return; }
    out.textContent = JSON.stringify(r.response, null, 2).slice(0, 4000);
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
});

(async () => {
  await initLang(STRINGS);
  bindLangSwitch();
  applyTranslations();
  refresh();
})();
