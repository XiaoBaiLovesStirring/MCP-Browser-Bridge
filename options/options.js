// options/options.js
import {
  loadEngines, saveEngines, resetEngines, validateEngine, engineIdFromName, DEFAULT_ENGINES,
} from "../lib/search-engines.js";
import { loadSettings, saveSettings, validatePort, VALID_TRANSPORTS } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

let engines = [];
let editingIndex = -1; // -1 = adding new

// ---------- Status polling ----------
function setStatusUI(connected, status) {
  const pill = $("statusPill");
  const state = connected ? "connected" : (status && status.state) || "unknown";
  pill.dataset.state = state;
  pill.querySelector(".status-text").textContent = connected
    ? "Connected"
    : (status && status.detail) ? status.detail : (status && status.state) || "Idle";
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get-status" });
    if (resp && resp.ok) setStatusUI(resp.connected, resp.status);
  } catch (e) {
    setStatusUI(false, { state: "error", detail: e.message });
  }
}

// ---------- Settings form ----------
async function loadSettingsForm() {
  const s = await loadSettings();
  $("host").value = s.host;
  $("port").value = s.port;
  $("pageLoadTimeoutMs").value = s.pageLoadTimeoutMs;
  $("maxResults").value = s.maxResults;
  $("autoStart").checked = !!s.autoStart;
  $("tabLifecycle").value = s.tabLifecycle;
  setTransport(s.transport);
  updateEndpointHint(s.host, s.port);
}

function setTransport(value) {
  document.querySelectorAll("#transport .seg").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === value);
  });
}

function getTransport() {
  const active = document.querySelector("#transport .seg.active");
  return active ? active.dataset.value : "sse";
}

function updateEndpointHint(host, port) {
  $("endpointHint").textContent = `http://${host}:${port}`;
}

async function applySettings() {
  const port = Number($("port").value);
  const [ok, reason] = validatePort(port);
  if (!ok) return toast(reason, "err");

  const settings = {
    host: $("host").value.trim() || "127.0.0.1",
    port,
    transport: getTransport(),
    autoStart: $("autoStart").checked,
    tabLifecycle: $("tabLifecycle").value,
    pageLoadTimeoutMs: Number($("pageLoadTimeoutMs").value) || 15000,
    maxResults: Number($("maxResults").value) || 20,
  };
  const resp = await chrome.runtime.sendMessage({ type: "apply-settings", settings });
  if (resp && resp.ok) {
    updateEndpointHint(settings.host, settings.port);
    toast("Settings saved & applied", "ok");
    refreshStatus();
  } else {
    toast("Failed to apply settings", "err");
  }
}

// ---------- Engines UI ----------
function renderEngines() {
  const list = $("engineList");
  list.innerHTML = "";
  if (engines.length === 0) {
    list.innerHTML = '<div class="hint">No engines configured. Click "+ Add engine".</div>';
    return;
  }
  engines.forEach((eng, idx) => {
    const row = document.createElement("div");
    row.className = "engine-row";
    row.innerHTML = `
      <label class="toggle">
        <input type="checkbox" data-idx="${idx}" class="eng-toggle" ${eng.enabled ? "checked" : ""}/>
        <span class="slider"></span>
      </label>
      <div>
        <div class="eng-name">${escapeHtml(eng.name)} <span class="muted">(${escapeHtml(eng.id)})</span></div>
        <div class="eng-url">${escapeHtml(eng.urlTemplate)}</div>
      </div>
      <div class="eng-actions">
        <button class="btn small secondary" data-idx="${idx}" data-act="edit">Edit</button>
        <button class="btn small danger" data-idx="${idx}" data-act="del">Delete</button>
      </div>
    `;
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function openModal(idx) {
  editingIndex = idx;
  const eng = idx >= 0 ? engines[idx] : { name: "", urlTemplate: "", resultSelector: "", linkSelector: "a", titleSelector: "", snippetSelector: "", enabled: true };
  $("modalTitle").textContent = idx >= 0 ? "Edit engine" : "Add engine";
  $("engName").value = eng.name;
  $("engUrl").value = eng.urlTemplate;
  $("engResult").value = eng.resultSelector || "";
  $("engLink").value = eng.linkSelector || "a";
  $("engTitle").value = eng.titleSelector || "";
  $("engSnippet").value = eng.snippetSelector || "";
  $("engEnabled").checked = !!eng.enabled;
  $("modal").hidden = false;
}

function closeModal() {
  $("modal").hidden = true;
  editingIndex = -1;
}

function saveEngineFromModal() {
  const eng = {
    name: $("engName").value.trim(),
    urlTemplate: $("engUrl").value.trim(),
    resultSelector: $("engResult").value.trim(),
    linkSelector: $("engLink").value.trim() || "a",
    titleSelector: $("engTitle").value.trim(),
    snippetSelector: $("engSnippet").value.trim(),
    enabled: $("engEnabled").checked,
  };
  const [ok, reason] = validateEngine(eng);
  if (!ok) return toast(reason, "err");

  if (editingIndex >= 0) {
    eng.id = engines[editingIndex].id;
    engines[editingIndex] = eng;
  } else {
    eng.id = engineIdFromName(eng.name);
    // Avoid id collisions.
    let n = 1;
    while (engines.find((e) => e.id === eng.id)) {
      eng.id = `${engineIdFromName(eng.name)}-${n++}`;
    }
    engines.push(eng);
  }
  closeModal();
  renderEngines();
  toast("Engine saved (remember to click \"Save engines\")", "ok");
}

async function persistEngines() {
  await saveEngines(engines);
  toast("Engines saved", "ok");
}

async function doResetEngines() {
  engines = await resetEngines();
  renderEngines();
  toast("Engines reset to defaults", "ok");
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + (kind || "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); }, 2200);
}

// ---------- Wire up ----------
function bindEvents() {
  // Transport segmented control
  document.querySelectorAll("#transport .seg").forEach((btn) => {
    btn.addEventListener("click", () => setTransport(btn.dataset.value));
  });

  $("port").addEventListener("input", () => {
    updateEndpointHint($("host").value || "127.0.0.1", $("port").value || "8765");
  });
  $("host").addEventListener("input", () => {
    updateEndpointHint($("host").value || "127.0.0.1", $("port").value || "8765");
  });

  $("saveServerBtn").addEventListener("click", applySettings);
  $("reconnectBtn").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "reconnect" });
    if (r && r.ok) toast("Reconnected", "ok");
    else toast("Reconnect failed", "err");
    refreshStatus();
  });
  $("disconnectBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
    toast("Disconnected", "ok");
    refreshStatus();
  });

  $("addEngineBtn").addEventListener("click", () => openModal(-1));
  $("modalCancel").addEventListener("click", closeModal);
  $("modalSave").addEventListener("click", saveEngineFromModal);
  $("saveEnginesBtn").addEventListener("click", persistEngines);
  $("resetEnginesBtn").addEventListener("click", doResetEngines);

  // Event delegation for engine list
  $("engineList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      const idx = Number(btn.dataset.idx);
      if (btn.dataset.act === "edit") openModal(idx);
      else if (btn.dataset.act === "del") {
        engines.splice(idx, 1);
        renderEngines();
        toast("Deleted (click \"Save engines\" to persist)", "ok");
      }
    }
  });
  $("engineList").addEventListener("change", (e) => {
    if (e.target.classList.contains("eng-toggle")) {
      const idx = Number(e.target.dataset.idx);
      engines[idx].enabled = e.target.checked;
    }
  });

  // Close modal on backdrop click
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
}

async function init() {
  bindEvents();
  await loadSettingsForm();
  engines = await loadEngines();
  renderEngines();
  refreshStatus();
  setInterval(refreshStatus, 3000);
}

init();
