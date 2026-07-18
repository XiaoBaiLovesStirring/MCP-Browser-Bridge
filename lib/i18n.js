// lib/i18n.js
// Shared internationalization for all extension pages (options, popup, mcp console, installer).
// Persists the user's choice in chrome.storage.local. Auto-detects from navigator.language
// on first run. Exposes a tiny pub/sub so pages can re-render on language change.

const LANG_KEY = "mcpbb_lang";
const SUPPORTED = ["en", "zh"];
let current = "en";
let listeners = [];

/** Detect initial language from the browser, falling back to English. */
function detect() {
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

/** Initialize from storage (or auto-detect on first run). Returns the resolved lang. */
export async function initLang(translations) {
  // Store the translations table on first init so t() can use it.
  if (translations) I18N_DICT = translations;
  const { [LANG_KEY]: stored } = await chrome.storage.local.get(LANG_KEY);
  current = SUPPORTED.includes(stored) ? stored : detect();
  return current;
}

/** Use only the in-memory dict (for installer which has no chrome.storage). */
export function setDict(translations) {
  I18N_DICT = translations;
}

let I18N_DICT = {};

/** Get the current language code ("en" or "zh"). */
export function getLang() {
  return current;
}

/** Translate a key. Falls back to English, then to the key itself. */
export function t(key) {
  const dict = (I18N_DICT && I18N_DICT[current]) || {};
  if (key in dict) return dict[key];
  const enDict = (I18N_DICT && I18N_DICT.en) || {};
  return enDict[key] || key;
}

/** Switch language and persist. Notifies listeners. */
export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  current = lang;
  try {
    await chrome.storage.local.set({ [LANG_KEY]: lang });
  } catch (_) {
    // Installer (file://) has no chrome.storage; ignore.
  }
  listeners.forEach((fn) => fn(current));
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

/** Apply translations to all [data-i18n] elements in the document.
 *  Translations may contain inline HTML (code, b, etc.). */
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    el.innerHTML = val;
  });
  // Also handle [data-i18n-attr] = "key:attr,key2:attr2"
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const spec = el.getAttribute("data-i18n-attr");
    spec.split(",").forEach((pair) => {
      const [key, attr] = pair.split(":").map((s) => s.trim());
      if (key && attr) el.setAttribute(attr, t(key));
    });
  });
}

/** Build the EN/中文 language switcher markup. Callers style it via .lang-switch / .lang. */
export function langSwitchHTML() {
  return `
    <div class="lang-switch" id="langSwitch">
      <button type="button" data-lang="en" class="lang">EN</button>
      <button type="button" data-lang="zh" class="lang">中文</button>
    </div>
  `;
}

/** Wire up the language switcher buttons (call after applyTranslations). */
export function bindLangSwitch() {
  const sw = document.getElementById("langSwitch");
  if (!sw) return;
  const update = () => {
    sw.querySelectorAll(".lang").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === current);
    });
  };
  update();
  sw.querySelectorAll(".lang").forEach((b) => {
    b.addEventListener("click", async () => {
      await setLang(b.dataset.lang);
      applyTranslations();
      update();
    });
  });
  onLangChange(() => {
    update();
    applyTranslations();
  });
}

export { LANG_KEY, SUPPORTED };
