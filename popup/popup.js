// popup/popup.js
const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "get-status" });
    if (r && r.ok) {
      $("statusText").textContent = `Active · ${r.toolCount} tools`;
      $("meta").textContent = `v${r.version} · ${r.extensionId ? r.extensionId.slice(0, 16) + "…" : ""}`;
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
  out.textContent = "Searching…";
  try {
    const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "search", arguments: { query } } };
    const r = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
    if (!r || !r.ok) { out.textContent = "Error: " + (r ? r.error : "no response"); return; }
    out.textContent = JSON.stringify(r.response, null, 2).slice(0, 4000);
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
});

refresh();
