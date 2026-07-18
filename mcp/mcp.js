// mcp/mcp.js
// Built-in MCP console. Lets the user invoke any tool or send raw JSON-RPC.
// Uses the internal message bus (chrome.runtime.sendMessage) to reach the
// service worker, so it always works with zero setup.

const $ = (id) => document.getElementById(id);
let tools = [];

function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + (kind || "");
  t.hidden = false;
  setTimeout(() => t.classList.remove("show"), 2000);
}

async function loadTools() {
  const resp = await chrome.runtime.sendMessage({ type: "list-tools" });
  if (!resp || !resp.ok) {
    toast("Failed to load tools", "err");
    return;
  }
  tools = resp.tools;
  const sel = $("toolSelect");
  sel.innerHTML = "";
  tools.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  renderToolDesc();
}

function renderToolDesc() {
  const name = $("toolSelect").value;
  const t = tools.find((x) => x.name === name);
  if (!t) { $("toolDesc").textContent = ""; return; }
  const required = (t.inputSchema && t.inputSchema.required) || [];
  const props = (t.inputSchema && t.inputSchema.properties) || {};
  const propLines = Object.keys(props).map((k) => {
    const p = props[k];
    const req = required.includes(k) ? " (required)" : "";
    const def = p.default !== undefined ? ` [default: ${JSON.stringify(p.default)}]` : "";
    return `  ${k}: ${p.type || "?"}${req}${def} — ${p.description || ""}`;
  });
  $("toolDesc").textContent = `${t.description}\n\nArguments:\n${propLines.join("\n") || "  (none)"}`;
}

async function loadExtId() {
  const resp = await chrome.runtime.sendMessage({ type: "get-status" });
  if (resp && resp.ok && resp.extensionId) {
    $("extId").value = resp.extensionId;
    $("idPill").textContent = `Extension ID: ${resp.extensionId.slice(0, 12)}…`;
    $("idInSnippet").textContent = resp.extensionId;
  }
}

async function callTool() {
  const name = $("toolSelect").value;
  const argsText = $("toolArgs").value.trim() || "{}";
  let args;
  try { args = JSON.parse(argsText); }
  catch (e) { toast("Invalid JSON arguments: " + e.message, "err"); return; }

  const out = $("output");
  out.hidden = false;
  out.textContent = `Calling ${name}…`;
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } };
  const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
  if (!resp || !resp.ok) {
    out.textContent = `Error: ${resp ? resp.error : "no response"}`;
    return;
  }
  out.textContent = JSON.stringify(resp.response, null, 2);
}

async function sendRaw() {
  const text = $("rawInput").value.trim();
  if (!text) { toast("Empty request", "err"); return; }
  let payload;
  try { payload = JSON.parse(text); }
  catch (e) { toast("Invalid JSON: " + e.message, "err"); return; }
  const out = $("rawOutput");
  out.hidden = false;
  out.textContent = "Sending…";
  const resp = await chrome.runtime.sendMessage({ type: "mcp-request", payload });
  if (!resp || !resp.ok) {
    out.textContent = `Error: ${resp ? resp.error : "no response"}`;
    return;
  }
  out.textContent = resp.response ? JSON.stringify(resp.response, null, 2) : "(notification accepted, no response)";
}

$("copyId").addEventListener("click", async () => {
  const id = $("extId").value;
  try {
    await navigator.clipboard.writeText(id);
    toast("Extension ID copied", "ok");
  } catch (e) {
    toast("Copy failed: " + e.message, "err");
  }
});
$("toolSelect").addEventListener("change", renderToolDesc);
$("refreshTools").addEventListener("click", loadTools);
$("callTool").addEventListener("click", callTool);
$("clearOutput").addEventListener("click", () => { $("output").hidden = true; $("output").textContent = ""; });
$("sendRaw").addEventListener("click", sendRaw);

// Seed raw input with a tools/list example.
$("rawInput").value = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null, 2);

loadExtId();
loadTools();
