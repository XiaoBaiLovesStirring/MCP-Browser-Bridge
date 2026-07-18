// lib/settings.js
// Extension settings. Pure browser extension — no native host, no port config.

const SETTINGS_KEY = "mcpbb_settings";

export const DEFAULT_SETTINGS = {
  // Tab lifecycle: "keep" (leave tab open) | "close" (close after extraction)
  tabLifecycle: "close",
  // Max wait time (ms) for a search page to load before extraction.
  pageLoadTimeoutMs: 15000,
  // Max number of result items to extract per search.
  maxResults: 20,
};

/** Load settings merged with defaults. */
export async function loadSettings() {
  const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

/** Persist settings. */
export async function saveSettings(partial) {
  const current = await loadSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export { SETTINGS_KEY };