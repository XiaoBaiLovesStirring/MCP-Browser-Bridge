// options/options.js
import {
  loadEngines, saveEngines, resetEngines, validateEngine, engineIdFromName,
} from "../lib/search-engines.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { STRINGS } from "../lib/strings.js";
import { initLang, t, applyTranslations, bindLangSwitch, onLangChange } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

let engines = [];
let editingIndex = -1;

async function loadBehaviorForm() {
  const s = await loadSettings();
  $("tabLifecycle").value = s.tabLifecycle;
  $("pageLoadTimeoutMs").value = s.pageLoadTimeoutMs;
  $("maxResults").value = s.maxResults;
}

async function loadBridgeForm() {
  const s = await loadSettings();
  $("hostEnabled").checked = !!s.hostEnabled;
  $("host").value = s.host || "127.0.0.1";
  $("port").value = s.port || 7777;
  $("transport").value = s.transport || "both";
  await refreshBridgeStatus();
}

async function saveBridge() {
  const settings = {
    hostEnabled: $("hostEnabled").checked,
    host: $("host").value.trim() || "127.0.0.1",
    port: Number($("port").value) || 7777,
    transport: $("transport").value || "both",
  };
  await chrome.runtime.sendMessage({ type: "apply-settings", settings });
  toast(t("opt.saved"), "ok");
  await refreshBridgeStatus();
}

async function refreshBridgeStatus() {
  // Always recompute endpoint URLs from current form values so the user can
  // see what the configured URL will be even before connecting.
  const host = $("host").value.trim() || "127.0.0.1";
  const port = Number($("port").value) || 7777;
  $("epHttp").value = `http://${host}:${port}/mcp`;
  $("epSse").value = `http://${host}:${port}/sse`;
  $("epHealth").value = `http://${host}:${port}/health`;

  try {
    const r = await chrome.runtime.sendMessage({ type: "bridge-get-status" });
    if (!r || !r.ok) return;
    const pill = $("bridgePill");
    const stateText = $("bridgeStateText");
    const errBox = $("bridgeErrorBox");
    if (r.ready) {
      pill.dataset.state = "connected";
      stateText.textContent = t("opt.bridgeConnected");
      errBox.hidden = true;
    } else {
      pill.dataset.state = r.status && r.status.error ? "error" : "disconnected";
      stateText.textContent = r.status && r.status.attempts > 0
        ? `${t("opt.bridgeAttempting")} (${r.status.attempts})`
        : t("opt.bridgeDisconnected");
      if (r.status && r.status.error) {
        errBox.hidden = false;
        errBox.textContent = `${t("opt.bridgeError")}${r.status.error}` +
          (r.status.attempts ? ` · ${t("opt.bridgeAttempts")}${r.status.attempts}` : "");
      } else {
        errBox.hidden = true;
      }
    }
  } catch (e) {
    // ignore — service worker may be asleep
  }
}

async function saveBehavior() {
  const settings = {
    tabLifecycle: $("tabLifecycle").value,
    pageLoadTimeoutMs: Number($("pageLoadTimeoutMs").value) || 15000,
    maxResults: Number($("maxResults").value) || 20,
  };
  await chrome.runtime.sendMessage({ type: "apply-settings", settings });
  toast(t("opt.saved"), "ok");
}

function renderEngines() {
  const list = $("engineList");
  list.innerHTML = "";
  if (engines.length === 0) {
    list.innerHTML = `<div class="hint">${t("opt.noEngines")}</div>`;
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
        <button class="btn small secondary" data-idx="${idx}" data-act="edit">${t("opt.edit")}</button>
        <button class="btn small danger" data-idx="${idx}" data-act="del">${t("opt.delete")}</button>
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
  $("modalTitle").textContent = idx >= 0 ? t("opt.modalEditTitle") : t("opt.modalAddTitle");
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
    let n = 1;
    while (engines.find((e) => e.id === eng.id)) {
      eng.id = `${engineIdFromName(eng.name)}-${n++}`;
    }
    engines.push(eng);
  }
  closeModal();
  renderEngines();
  toast(t("opt.engineSaved"), "ok");
}

async function persistEngines() {
  await saveEngines(engines);
  toast(t("opt.enginesSaved"), "ok");
}

async function doResetEngines() {
  engines = await resetEngines();
  renderEngines();
  toast(t("opt.enginesReset"), "ok");
}

let toastTimer = null;
function toast(msg, kind) {
  const tt = $("toast");
  tt.textContent = msg;
  tt.className = "toast show " + (kind || "");
  tt.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { tt.classList.remove("show"); }, 2200);
}

function bindEvents() {
  bindLangSwitch();
  $("openConsole").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("mcp/mcp.html") }));
  $("saveBehaviorBtn").addEventListener("click", saveBehavior);
  $("saveBridgeBtn").addEventListener("click", saveBridge);
  $("reconnectBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "bridge-reconnect" });
    toast(t("opt.bridgeAttempting"), "ok");
    setTimeout(refreshBridgeStatus, 800);
  });
  $("disconnectBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "bridge-disconnect" });
    setTimeout(refreshBridgeStatus, 300);
  });

  // Copy endpoint URL buttons.
  document.querySelectorAll(".bridge-ep-row button[data-ep]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const which = btn.dataset.ep;
      const input = which === "http" ? $("epHttp") : which === "sse" ? $("epSse") : $("epHealth");
      try {
        await navigator.clipboard.writeText(input.value);
        toast(t("opt.bridgeCopied"), "ok");
      } catch (e) {
        toast(t("opt.bridgeCopy") + ": " + e.message, "err");
      }
    });
  });

  // Re-render endpoints live as host/port fields change.
  ["host", "port"].forEach((id) => {
    $(id).addEventListener("input", refreshBridgeStatus);
  });

  $("addEngineBtn").addEventListener("click", () => openModal(-1));
  $("modalCancel").addEventListener("click", closeModal);
  $("modalSave").addEventListener("click", saveEngineFromModal);
  $("saveEnginesBtn").addEventListener("click", persistEngines);
  $("resetEnginesBtn").addEventListener("click", doResetEngines);

  $("engineList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      const idx = Number(btn.dataset.idx);
      if (btn.dataset.act === "edit") openModal(idx);
      else if (btn.dataset.act === "del") {
        engines.splice(idx, 1);
        renderEngines();
        toast(t("opt.deleted"), "ok");
      }
    }
  });
  $("engineList").addEventListener("change", (e) => {
    if (e.target.classList.contains("eng-toggle")) {
      const idx = Number(e.target.dataset.idx);
      engines[idx].enabled = e.target.checked;
    }
  });

  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });

  // Re-render engine list (which has localized button labels) on language change.
  onLangChange(() => renderEngines());
}

async function init() {
  await initLang(STRINGS);
  bindEvents();
  applyTranslations();
  await loadBehaviorForm();
  await loadBridgeForm();
  engines = await loadEngines();
  renderEngines();
  // Periodically refresh the bridge status pill while the options page is open.
  setInterval(refreshBridgeStatus, 3000);
}

init();
