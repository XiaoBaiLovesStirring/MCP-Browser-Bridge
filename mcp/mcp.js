// mcp/mcp.js
// Built-in MCP console for MCP-Browser-Bridge.
// List tools, invoke tools with JSON arguments, send raw JSON-RPC.
// Uses chrome.runtime.sendMessage internally — no native host, no port.

import { initLang, t, applyTranslations, bindLangSwitch } from "../lib/i18n.js";
import { STRINGS } from "../lib/strings.js";

const $ = (sel) => document.getElementById(sel);

let tools = [];

async function loadExtId() {
  const resp = await chrome.runtime.sendMessage({ type: "get-status" });
  if (resp && resp.ok && resp.extensionId) {
    $("extId").value = resp.extensionId;
    $("idInSnippet").textContent = resp.extensionId;
  }
}

async function loadTools() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "list-tools" });
    if (resp && resp.ok) {
      tools = resp.tools;
      renderToolSelect();
      renderToolDesc();
    }
  } catch (e) {
    toast(t("mcp.failedLoadTools") + ": " + e.message, "err");
  }
}

function renderToolSelect() {
  const sel = $("toolSelect");
  sel.innerHTML = tools.map((t) => `<option value="${t.name}">${t.name}</option>`).join("");
}

function renderToolDesc() {
  const name = $("toolSelect").value;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    $("toolDesc").innerHTML = "";
    return;
  }
  const schema = tool.inputSchema;
  const props = schema && schema.properties ? Object.entries(schema.properties).map(([k, v]) => {
    const required = schema.required && schema.required.includes(k) ? " (required)" : "";
    const type = v.type || "any";
    const desc = v.description ? ` — ${v.description}` : "";
    return `<div><strong>${k}</strong> <code>${type}</code>${required}${desc}</div>`;
  }).join("") : "<em>no arguments</em>";
  $("toolDesc").innerHTML = `<p class="tool-summary">${escapeHtml(tool.description || "")}</p><div class="schema">${props}</div>`;
}

async function callTool() {
  const name = $("toolSelect").value;
  let args = {};
  const raw = $("toolArgs").value.trim();
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch (e) {
      toast(t("opt.invalidArgs") + e.message, "err");
      return;
    }
  }
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  };
  try {
    const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
    showResponse(resp);
  } catch (e) {
    showOutput("Error: " + e.message, true);
  }
}

async function sendRaw() {
  const raw = $("rawInput").value.trim();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    toast(t("opt.invalidArgs") + e.message, "err");
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
    showResponse(resp);
  } catch (e) {
    showOutput("Error: " + e.message, true);
  }
}

function showResponse(resp) {
  if (resp && resp.ok && resp.response) {
    showOutput(JSON.stringify(resp.response, null, 2));
  } else if (resp && resp.ok && resp.accepted) {
    showOutput("[notification accepted — no response]");
  } else {
    showOutput("Error: " + (resp && resp.error ? resp.error : "unknown"), true);
  }
}

function showOutput(text, isError) {
  const out = $("output");
  const hint = $("outputHint");
  out.hidden = false;
  hint.hidden = true;
  out.textContent = text;
  if (isError) out.style.color = "var(--danger)";
  else out.style.color = "";
}

function toast(msg, kind) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2500);
}

function escapeHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
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
$("clearOutput").addEventListener("click", () => { $("output").hidden = true; $("output").textContent = ""; $("outputHint").hidden = false; });
$("sendRaw").addEventListener("click", sendRaw);

(async () => {
  await initLang(STRINGS);
  bindLangSwitch();
  applyTranslations();
  loadExtId();
  loadTools();
})();