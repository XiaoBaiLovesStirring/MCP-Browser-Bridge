// popup/popup.js
import { loadSettings } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

function setStatus(connected, status) {
  const dot = $("statusDot");
  const text = $("statusText");
  dot.className = "dot";
  if (connected) {
    dot.classList.add("connected");
    text.textContent = "Connected";
  } else if (status && status.state === "error") {
    dot.classList.add("error");
    text.textContent = status.detail || "Error";
  } else {
    text.textContent = (status && status.detail) || "Disconnected";
  }
}

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "get-status" });
    if (r && r.ok) setStatus(r.connected, r.status);
  } catch (e) {
    setStatus(false, { state: "error", detail: e.message });
  }
}

async function updateEndpoint() {
  const s = await loadSettings();
  $("endpoint").textContent = `${s.transport.toUpperCase()} · http://${s.host}:${s.port}`;
}

$("reconnectBtn").addEventListener("click", async () => {
  $("statusText").textContent = "Reconnecting…";
  await chrome.runtime.sendMessage({ type: "reconnect" });
  refresh();
});

$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("searchBtn").addEventListener("click", async () => {
  const query = $("queryInput").value.trim();
  if (!query) return;
  const out = $("testOutput");
  out.hidden = false;
  out.textContent = "Searching…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Use the MCP tool via the background (simulates a real MCP client call).
    const r = await chrome.runtime.sendMessage({ type: "get-status" });
    if (!r || !r.connected) {
      out.textContent = "Bridge not connected. Open Settings → Reconnect.";
      return;
    }
    // Drive the search by opening the engine URL in a new tab and extracting.
    const { runSearch } = await import("../lib/search-runner.js");
    const { loadEngines, enabledEngines } = await import("../lib/search-engines.js");
    const engines = await loadEngines();
    const en = enabledEngines(engines)[0];
    if (!en) { out.textContent = "No enabled engine."; return; }
    const data = await runSearch(en, query, await loadSettings());
    out.textContent = JSON.stringify(data, null, 2).slice(0, 4000);
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
});

$("extractBtn").addEventListener("click", async () => {
  const out = $("extractOutput");
  out.hidden = false;
  out.textContent = "Extracting…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { out.textContent = "No active tab."; return; }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "extract-current", maxLinks: 20 });
    if (resp && resp.ok) {
      const d = resp.data;
      out.textContent = JSON.stringify({
        url: d.url, title: d.title, textLength: d.textLength,
        linkCount: d.linkCount, links: d.links, headings: d.headings,
      }, null, 2).slice(0, 4000);
    } else {
      out.textContent = "No response from content script.";
    }
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  }
});

refresh();
updateEndpoint();
setInterval(refresh, 3000);
