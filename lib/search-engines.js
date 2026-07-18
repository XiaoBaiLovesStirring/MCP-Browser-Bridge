// lib/search-engines.js
// Search engine configuration model + storage helpers.
// Each engine: { id, name, urlTemplate, enabled, selector, linkSelector }

const DEFAULT_ENGINES = [
  {
    id: "google",
    name: "Google",
    urlTemplate: "https://www.google.com/search?q={query}",
    enabled: true,
    resultSelector: "div.g",
    linkSelector: "a",
    titleSelector: "h3",
    snippetSelector: "div[data-sncf]",
  },
  {
    id: "bing",
    name: "Bing",
    urlTemplate: "https://www.bing.com/search?q={query}",
    enabled: true,
    resultSelector: "li.b_algo",
    linkSelector: "a",
    titleSelector: "h2",
    snippetSelector: "p",
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    urlTemplate: "https://duckduckgo.com/?q={query}",
    enabled: true,
    resultSelector: "article, div.result",
    linkSelector: "a",
    titleSelector: "h2, a.result__a",
    snippetSelector: ".result__snippet",
  },
  {
    id: "baidu",
    name: "Baidu",
    urlTemplate: "https://www.baidu.com/s?wd={query}",
    enabled: false,
    resultSelector: "div.result",
    linkSelector: "a",
    titleSelector: "h3",
    snippetSelector: ".c-abstract",
  },
];

const STORAGE_KEY = "mcpbb_engines";

/** Build a search URL from a template and query. */
export function buildSearchUrl(urlTemplate, query) {
  return urlTemplate.replace("{query}", encodeURIComponent(query));
}

/** Validate an engine object. Returns [true] or [false, reason]. */
export function validateEngine(engine) {
  if (!engine || typeof engine !== "object") return [false, "engine must be an object"];
  if (!engine.name || typeof engine.name !== "string") return [false, "name is required"];
  if (!engine.urlTemplate || typeof engine.urlTemplate !== "string") {
    return [false, "urlTemplate is required"];
  }
  if (!engine.urlTemplate.includes("{query}")) {
    return [false, "urlTemplate must contain {query} placeholder"];
  }
  return [true];
}

/** Generate a stable id from a name. */
export function engineIdFromName(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "engine-" + Math.random().toString(36).slice(2, 8);
}

/** Load all engines from storage. Falls back to defaults if none saved. */
export async function loadEngines() {
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored || !Array.isArray(stored) || stored.length === 0) {
    return DEFAULT_ENGINES.map((e) => ({ ...e }));
  }
  return stored;
}

/** Persist engines to storage. */
export async function saveEngines(engines) {
  await chrome.storage.local.set({ [STORAGE_KEY]: engines });
}

/** Reset to defaults. */
export async function resetEngines() {
  await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_ENGINES.map((e) => ({ ...e })) });
  return DEFAULT_ENGINES.map((e) => ({ ...e }));
}

/** Return only enabled engines. */
export function enabledEngines(engines) {
  return engines.filter((e) => e.enabled);
}

/** Find engine by id. */
export function findEngine(engines, id) {
  return engines.find((e) => e.id === id);
}

export { DEFAULT_ENGINES, STORAGE_KEY };
