// lib/settings.js
// Extension settings. Includes native host connection config (default
// 127.0.0.1:7777) so desktop MCP clients can reach the extension via the
// Node.js native messaging host.

const SETTINGS_KEY = "mcpbb_settings";

export const DEFAULT_SETTINGS = {
  // Tab lifecycle: "keep" (leave tab open) | "close" (close after extraction)
  tabLifecycle: "close",
  // Max wait time (ms) for a search page to load before extraction.
  pageLoadTimeoutMs: 15000,
  // Max number of result items to extract per search.
  maxResults: 20,

  // --- Native host (Node.js) connection ---
  // The host actually listens on the port configured at host startup
  // (env MCPBB_PORT, default 7777). These fields are informational: they
  // tell the UI what to display and what URL to suggest to MCP clients.
  hostEnabled: true,           // auto-connect to the native host on startup
  host: "127.0.0.1",
  port: 7777,
  // Which transports the host should serve. The host always serves both
  // Streamable HTTP and legacy SSE; this field is purely informational for
  // the UI. Values: "http" | "sse" | "both"
  transport: "both",
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
