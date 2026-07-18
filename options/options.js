// options/options.js
// Settings page for MCP-Browser-Bridge.
// Controls: behavior (tab lifecycle, page timeout, max results),
// search engine CRUD, and language switcher.
// Pure extension — no native host, no port config.

import { initLang, t, applyTranslations, bindLangSwitch } from "../lib/i18n.js";
import { STRINGS } from "../lib/strings.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { loadEngines, validateEngine, DEFAULT_ENGINES, engineIdFromName, saveEngines as saveEnginesStore } from "../lib/search-engines.js";

const $ = (sel) => document.getElementById(sel);

let engines = [];
let editingIndex = -1;

// --------------------------------------------------------------------------- //
// Behavior form
// --------------------------------------------------------------------------- //

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
  toast(t("opt.saved"), "ok");
}

// --------------------------------------------------------------------------- //
// Engine list
// --------------------------------------------------------------------------- //

function renderEngines() {
  const list = $("engineList");
  if (engines.length === 0) {
    list.innerHTML = `<p class="hint">${t("opt.noEngines")}</p>`;
    return;
  }
  list.innerHTML = engines
    .map(
      (e, i) => `<div class="engine-row ${e.enabled ? "" : "disabled"}">
      <div class="engine-info">
        <strong>${escapeHtml(e.name)}</strong>
        <span class="engine-url">${escapeHtml(e.urlTemplate)}</span>
        <span class="engine-selectors">${e.resultSelector || "—"} · ${e.linkSelector || "a"} · ${e.titleSelector || "—"} · ${e.snippetSelector || "—"}</span>
      </div>
      <div class="engine-actions">
        <button class="btn ghost small" data-action="edit" data-idx="${i}">${t("opt.edit")}</button>
        <button class="btn ghost small" data-action="del" data-idx="${i}">${t("opt.delete")}</button>
      </div>
    </div>`
    )
    .join("");

  list.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", () => openModal(Number(btn.dataset.idx)));
  });
  list.querySelectorAll("[data-action='del']").forEach((btn) => {
    btn.addEventListener("click", () => deleteEngine(Number(btn.dataset.idx)));
  });
}

function openModal(idx) {
  editingIndex = idx;
  $("modalTitle").textContent = idx >= 0 ? t("opt.modalEditTitle") : t("opt.modalAddTitle");
  if (idx >= 0 && idx < engines.length) {
    const e = engines[idx];
    $("engName").value = e.name;
    $("engUrl").value = e.urlTemplate;
    $("engResult").value = e.resultSelector || "";
    $("engLink").value = e.linkSelector || "a";
    $("engTitle").value = e.titleSelector || "";
    $("engSnippet").value = e.snippetSelector || "";
    $("engEnabled").checked = e.enabled !== false;
  } else {
    $("engName").value = "";
    $("engUrl").value = "";
    $("engResult").value = "";
    $("engLink").value = "a";
    $("engTitle").value = "";
    $("engSnippet").value = "";
    $("engEnabled").checked = true;
  }
  $("modal").hidden = false;
}

function closeModal() {
  $("modal").hidden = true;
  editingIndex = -1;
}

function saveModal() {
  const engine = {
    id: null,
    name: $("engName").value.trim(),
    urlTemplate: $("engUrl").value.trim(),
    resultSelector: $("engResult").value.trim() || null,
    linkSelector: $("engLink").value.trim() || "a",
    titleSelector: $("engTitle").value.trim() || null,
    snippetSelector: $("engSnippet").value.trim() || null,
    enabled: $("engEnabled").checked,
  };
  const err = validateEngine(engine);
  if (err) {
    toast(err, "err");
    return;
  }
  if (editingIndex >= 0 && editingIndex < engines.length) {
    engine.id = engines[editingIndex].id;
    engines[editingIndex] = engine;
  } else {
    engine.id = engineIdFromName(engine.name);
    engines.push(engine);
  }
  renderEngines();
  closeModal();
}

async function deleteEngine(idx) {
  if (idx < 0 || idx >= engines.length) return;
  engines.splice(idx, 1);
  renderEngines();
}

async function saveEngines() {
  await saveEnginesStore(engines);
  toast(t("opt.saved"), "ok");
}

async function resetEngines() {
  engines = JSON.parse(JSON.stringify(DEFAULT_ENGINES));
  renderEngines();
  await saveEnginesStore(engines);
  toast(t("opt.saved"), "ok");
}

// --------------------------------------------------------------------------- //
// Toast
// --------------------------------------------------------------------------- //

function toast(msg, kind) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2500);
}

// --------------------------------------------------------------------------- //
// Util
// --------------------------------------------------------------------------- //

function escapeHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //

function bindEvents() {
  bindLangSwitch();
  $("openConsole").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("mcp/mcp.html") }));
  $("saveBehaviorBtn").addEventListener("click", saveBehavior);
  $("addEngineBtn").addEventListener("click", () => openModal(-1));
  $("modalCancel").addEventListener("click", closeModal);
  $("modalSave").addEventListener("click", saveModal);
  $("saveEnginesBtn").addEventListener("click", saveEngines);
  $("resetEnginesBtn").addEventListener("click", resetEngines);
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
}

// --------------------------------------------------------------------------- //
// Init
// --------------------------------------------------------------------------- //

async function init() {
  await initLang(STRINGS);
  bindEvents();
  applyTranslations();
  await loadBehaviorForm();
  engines = await loadEngines();
  renderEngines();
}

init();