// mcp/mcp.js
// Built-in MCP console. Lets the user invoke any tool or send raw JSON-RPC.
import { STRINGS } from "../lib/strings.js";
import { initLang, t, applyTranslations, bindLangSwitch } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);
let tools = [];

function toast(msg, kind) {
  const tt = $("toast");
  tt.textContent = msg;
  tt.className = "toast show " + (kind || "");
  tt.hidden = false;
  setTimeout(() => tt.classList.remove("show"), 2000);
}

async function loadTools() {
  const resp = await chrome.runtime.sendMessage({ type: "list-tools" });
  if (!resp || !resp.ok) {
    toast(t("mcp.failedLoadTools"), "err");
    return;
  }
  tools = resp.tools;
  const sel = $("toolSelect");
  sel.innerHTML = "";
  tools.forEach((tl) => {
    const opt = document.createElement("option");
    opt.value = tl.name;
    opt.textContent = tl.name;
    sel.appendChild(opt);
  });
  renderToolDesc();
}

function renderToolDesc() {
  const name = $("toolSelect").value;
  const tl = tools.find((x) => x.name === name);
  if (!tl) { $("toolDesc").textContent = ""; return; }
  const required = (tl.inputSchema && tl.inputSchema.required) || [];
  const props = (tl.inputSchema && tl.inputSchema.properties) || {};
  const propLines = Object.keys(props).map((k) => {
    const p = props[k];
    const req = required.includes(k) ? " (required)" : "";
    const def = p.default !== undefined ? ` [default: ${JSON.stringify(p.default)}]` : "";
    return `  ${k}: ${p.type || "?"}${req}${def} — ${p.description || ""}`;
  });
  $("toolDesc").textContent = `${tl.description}\n\nArguments:\n${propLines.join("\n") || "  (none)"}`;
}

async function loadExtId() {
  const resp = await chrome.runtime.sendMessage({ type: "get-status" });
  if (resp && resp.ok && resp.extensionId) {
    $("extId").value = resp.extensionId;
    $("idInSnippet").textContent = resp.extensionId;
  }
}

async function refreshMcpBridge() {
  // Compute endpoints from current settings.
  let host = "127.0.0.1", port = 7777;
  try {
    const st = await chrome.runtime.sendMessage({ type: "get-status" });
    if (st && st.ok && st.settings) {
      host = st.settings.host || "127.0.0.1";
      port = st.settings.port || 7777;
    }
  } catch (_) {}
  $("mcpEpHttp").value = `http://${host}:${port}/mcp`;
  $("mcpEpSse").value = `http://${host}:${port}/sse`;

  try {
    const r = await chrome.runtime.sendMessage({ type: "bridge-get-status" });
    if (!r || !r.ok) return;
    const pill = $("mcpBridgePill");
    const stateText = $("mcpBridgeState");
    if (r.ready) {
      pill.dataset.state = "connected";
      stateText.textContent = t("mcp.bridgeConnected");
    } else {
      pill.dataset.state = r.status && r.status.error ? "error" : "disconnected";
      stateText.textContent = t("mcp.bridgeDisconnected");
    }
  } catch (e) {
    // ignore
  }
}

async function callTool() {
  const name = $("toolSelect").value;
  const argsText = $("toolArgs").value.trim() || "{}";
  let args;
  try { args = JSON.parse(argsText); }
  catch (e) { toast(t("mcp.invalidArgsJson") + e.message, "err"); return; }

  const out = $("output");
  out.hidden = false;
  out.textContent = t("mcp.calling").replace("{name}", name);
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } };
  const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
  if (!resp || !resp.ok) {
    out.textContent = `${t("mcp.error")}${resp ? resp.error : t("mcp.noResponse")}`;
    return;
  }
  out.textContent = JSON.stringify(resp.response, null, 2);
}

async function sendRaw() {
  const text = $("rawInput").value.trim();
  if (!text) { toast(t("mcp.emptyReq"), "err"); return; }
  let payload;
  try { payload = JSON.parse(text); }
  catch (e) { toast(t("mcp.invalidJson") + e.message, "err"); return; }
  const out = $("rawOutput");
  out.hidden = false;
  out.textContent = t("mcp.sending");
  const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
  if (!resp || !resp.ok) {
    out.textContent = `${t("mcp.error")}${resp ? resp.error : t("mcp.noResponse")}`;
    return;
  }
  out.textContent = resp.response ? JSON.stringify(resp.response, null, 2) : t("mcp.notifAccepted");
}

$("copyId").addEventListener("click", async () => {
  const id = $("extId").value;
  try {
    await navigator.clipboard.writeText(id);
    toast(t("mcp.copied"), "ok");
  } catch (e) {
    toast(t("mcp.copyFailed") + e.message, "err");
  }
});
$("toolSelect").addEventListener("change", renderToolDesc);
$("refreshTools").addEventListener("click", loadTools);
$("callTool").addEventListener("click", callTool);
$("clearOutput").addEventListener("click", () => { $("output").hidden = true; $("output").textContent = ""; });
$("sendRaw").addEventListener("click", sendRaw);
$("bridgeRefresh").addEventListener("click", refreshMcpBridge);
document.querySelectorAll(".bridge-ep-row button[data-mcp-ep]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const which = btn.dataset.mcpEp;
    const input = which === "http" ? $("mcpEpHttp") : $("mcpEpSse");
    try {
      await navigator.clipboard.writeText(input.value);
      toast(t("mcp.bridgeCopied"), "ok");
    } catch (e) {
      toast(t("mcp.bridgeCopy") + ": " + e.message, "err");
    }
  });
});

$("rawInput").value = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null, 2);

(async () => {
  await initLang(STRINGS);
  bindLangSwitch();
  applyTranslations();
  loadExtId();
  loadTools();
  refreshMcpBridge();
  setInterval(refreshMcpBridge, 3000);
})();
