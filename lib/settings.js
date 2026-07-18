// lib/settings.js
// Global extension settings: port, transport, native host connection state.

const SETTINGS_KEY = "mcpbb_settings";

export const DEFAULT_SETTINGS = {
  // Port the native host will listen on (user-selectable).
  port: 8765,
  // Transport exposed to MCP clients:
  //   "streamable" = MCP 2025-06-18 Streamable HTTP (recommended, /mcp endpoint)
  //   "sse"        = MCP 2024-11-05 legacy SSE (/sse + /messages endpoints)
  //   "both"       = enable all endpoints for maximum client compatibility
  transport: "both",
  // Bind address for the native host server.
  host: "127.0.0.1",
  // Whether the bridge should auto-start when the extension loads.
  autoStart: true,
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
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  // Migrate legacy transport values from v0.1.
  if (merged.transport === "http") merged.transport = "streamable";
  return merged;
}

/** Persist settings. */
export async function saveSettings(partial) {
  const current = await loadSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Validate a port number. Returns [true] or [false, reason]. */
export function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n)) return [false, "port must be an integer"];
  if (n < 1024 || n > 65535) return [false, "port must be between 1024 and 65535"];
  return [true];
}

export const VALID_TRANSPORTS = ["streamable", "sse", "both"];

export function validateTransport(t) {
  return VALID_TRANSPORTS.includes(t);
}

export { SETTINGS_KEY };
