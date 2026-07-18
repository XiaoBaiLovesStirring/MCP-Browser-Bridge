// options/options.js
import {
  loadEngines, saveEngines, resetEngines, validateEngine, engineIdFromName,
} from "../lib/search-engines.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

let engines = [];
let editingIndex = -1;

async function loadBehaviorForm() {
  const s = await loadSettings();
  $("tabLifecycle").value = s.tabLifecycle;
  $("pageLoadTimeoutMs").value = s.pageLoadTimeoutMs;
  $("maxResults").value = s.maxResults;
}

async function saveBehavior() {
  const settings = {
    tabLifecycle: $("tabLifecycle").value,
    pageLoadTimeoutMs: Number($("pageLoadTimeoutMs").value) || 15000,
    maxResults: Number($("maxResults").value) || 20,
  };
  await chrome.runtime.sendMessage({ type: "apply-settings", settings });
  toast("Saved", "ok");
}

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
    let n = 1;
    while (engines.find((e) => e.id === eng.id)) {
      eng.id = `${engineIdFromName(eng.name)}-${n++}`;
    }
    engines.push(eng);
  }
  closeModal();
  renderEngines();
  toast("Engine saved (click \"Save engines\" to persist)", "ok");
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

let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + (kind || "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); }, 2200);
}

function bindEvents() {
  $("openConsole").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("mcp/mcp.html") }));
  $("saveBehaviorBtn").addEventListener("click", saveBehavior);
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

  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
}

async function init() {
  bindEvents();
  await loadBehaviorForm();
  engines = await loadEngines();
  renderEngines();
}

init();
