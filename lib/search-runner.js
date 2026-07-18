// lib/search-runner.js
// Orchestrates: open a new tab -> wait for load -> extract -> close.
// Extraction is done by injecting a self-contained function via
// chrome.scripting.executeScript, so we never depend on a content script
// being preloaded on a fresh tab.

import { buildSearchUrl, findEngine } from "./search-engines.js";

/**
 * Wait for a tab to finish loading, with a timeout.
 * Resolves with the tab, or rejects on timeout.
 */
function waitForTabLoaded(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} did not load within ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(id, info, tab) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay to allow late DOM mutations (SPA render).
        setTimeout(() => resolve(tab), 250);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Injected into the page to extract search results.
 * MUST be self-contained: no external references, only DOM APIs.
 * `engine` is passed via args.
 */
function extractResultsInPage(engine) {
  const results = [];
  const seen = new Set();

  const root = engine.resultSelector
    ? document.querySelectorAll(engine.resultSelector)
    : [document.body];

  root.forEach((block) => {
    const linkEl = engine.linkSelector ? block.querySelector(engine.linkSelector) : block.querySelector("a");
    const titleEl = engine.titleSelector ? block.querySelector(engine.titleSelector) : linkEl;
    const snippetEl = engine.snippetSelector ? block.querySelector(engine.snippetSelector) : null;

    const href = linkEl && linkEl.href ? linkEl.href : null;
    if (!href || seen.has(href)) return;
    seen.add(href);

    const title = titleEl ? (titleEl.textContent || "").trim() : (linkEl && linkEl.textContent || "").trim();
    const snippet = snippetEl ? (snippetEl.textContent || "").trim() : "";

    results.push({ title, url: href, snippet });
  });

  // Fallback: if structured extraction yielded nothing, grab all links with text.
  if (results.length === 0) {
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href;
      const text = (a.textContent || "").trim();
      if (!href || !text || seen.has(href)) return;
      if (href.startsWith("javascript:") || href.startsWith("#")) return;
      seen.add(href);
      results.push({ title: text, url: href, snippet: "" });
    });
  }

  return {
    engine: engine.name,
    query: document.title,
    resultCount: results.length,
    results,
    pageUrl: location.href,
    pageTitle: document.title,
  };
}

/**
 * Injected into a page to extract generic text + links (for fetch_page tool).
 */
function extractPageContentInPage(maxLinks) {
  const text = (document.body && document.body.innerText) || "";
  const links = [];
  const seen = new Set();
  const anchors = document.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length && links.length < maxLinks; i++) {
    const a = anchors[i];
    const href = a.href;
    if (!href || seen.has(href)) continue;
    if (href.startsWith("javascript:") || href.startsWith("#")) continue;
    seen.add(href);
    links.push({ text: (a.textContent || "").trim(), url: href });
  }
  return {
    url: location.href,
    title: document.title,
    text,
    textLength: text.length,
    links,
    linkCount: links.length,
  };
}

/**
 * Run a search: open tab, wait, extract, optionally close.
 * Returns the extracted results object.
 */
export async function runSearch(engine, query, settings) {
  const url = buildSearchUrl(engine.urlTemplate, query);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

  try {
    await waitForTabLoaded(tabId, settings.pageLoadTimeoutMs || 15000);
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractResultsInPage,
      args: [engine],
    });
    const data = injected && injected.result ? injected.result : { results: [], error: "no result" };
    if (settings.maxResults && Array.isArray(data.results)) {
      data.results = data.results.slice(0, settings.maxResults);
      data.resultCount = data.results.length;
    }
    return data;
  } finally {
    if ((settings.tabLifecycle || "close") === "close") {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/**
 * Fetch an arbitrary URL: open tab, wait, extract text + links, close.
 */
export async function fetchPage(url, settings) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabLoaded(tabId, settings.pageLoadTimeoutMs || 15000);
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContentInPage,
      args: [settings.maxResults || 20],
    });
    return injected && injected.result ? injected.result : { text: "", links: [], error: "no result" };
  } finally {
    if ((settings.tabLifecycle || "close") === "close") {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/**
 * Extract content from the currently active tab (no new tab, no close).
 */
export async function extractCurrentTab(settings) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContentInPage,
    args: [settings.maxResults || 20],
  });
  return injected && injected.result ? injected.result : { text: "", links: [], error: "no result" };
}

// --------------------------------------------------------------------------- //
// AI page operation: arbitrary JS evaluation
// --------------------------------------------------------------------------- //
//
// Lets an MCP client (e.g. an LLM) run JavaScript inside a real browser tab.
// Use cases: click buttons, fill forms, read SPA-rendered DOM, parse the page's
// own JS state (window variables, framework internals), scrape dynamic content
// that only appears after JS execution, etc.
//
// `world`:
//   - "ISOLATED" (default): runs in the extension's isolated world. Safe, not
//     affected by page CSP, full DOM access, but cannot read the page's own
//     JS variables. Best for DOM manipulation and reading rendered HTML.
//   - "MAIN": runs in the page's main world. Can read/modify the page's JS
//     globals and SPA framework state (React/Vue/jQuery internals). Subject
//     to the page's CSP (strict CSP may block `new Function`).
//
// The user's code is wrapped in an async function body, so `await` works and
// the return value (or resolved promise) is sent back. Non-JSON-serializable
// values (DOM nodes, functions) are stringified so they survive the IPC hop.

function _evalJsInjected(userCode) {
  const stringifySafe = (v, seen) => {
    seen = seen || new Set();
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "function") return `[Function: ${v.name || "anonymous"}]`;
    if (t === "symbol") return v.toString();
    if (t !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    // DOM nodes -> concise summary
    if (v.nodeType && v.nodeName) {
      const summary = { nodeType: v.nodeType, nodeName: v.nodeName };
      if (v.id) summary.id = v.id;
      if (v.className && typeof v.className === "string") summary.className = v.className;
      if (v.getAttribute) {
        const href = v.getAttribute("href");
        if (href) summary.href = href;
        const src = v.getAttribute("src");
        if (src) summary.src = src;
      }
      if (v.textContent) summary.text = String(v.textContent).slice(0, 500);
      seen.delete(v);
      return summary;
    }
    if (Array.isArray(v)) {
      const arr = v.slice(0, 1000).map((x) => stringifySafe(x, seen));
      seen.delete(v);
      return arr;
    }
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 500) { out["__truncated__"] = true; break; }
      try { out[k] = stringifySafe(v[k], seen); } catch (_) { out[k] = "[unreadable]"; }
    }
    seen.delete(v);
    return out;
  };

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function("'use strict'; return (async () => {\n" + userCode + "\n});");
    const promise = factory();
    return Promise.resolve(promise).then(
      (value) => ({ ok: true, value: stringifySafe(value) }),
      (err) => ({
        ok: false,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : null,
        name: err && err.name ? err.name : null,
      })
    );
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : null,
      name: err && err.name ? err.name : null,
    };
  }
}

/**
 * Evaluate JS in a specific tab.
 * @param {number} tabId
 * @param {string} code - JS function body (may use `await`, `return` not needed; the last expression's resolved value is returned)
 * @param {object} options - { world: "ISOLATED"|"MAIN" }
 */
export async function evalJsInTab(tabId, code, options = {}) {
  const world = options.world === "MAIN" ? "MAIN" : "ISOLATED";
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func: _evalJsInjected,
    args: [code],
  });
  if (!injected || !injected.result) {
    return { ok: false, error: "injection returned no result" };
  }
  return injected.result;
}

/**
 * Open a new background tab to `url`, wait for load, eval JS, optionally close.
 */
export async function evalJsOnUrl(url, code, settings, options = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabLoaded(tabId, settings.pageLoadTimeoutMs || 15000);
    const result = await evalJsInTab(tabId, code, options);
    result.tabId = tabId;
    result.url = url;
    return result;
  } finally {
    if ((settings.tabLifecycle || "close") === "close") {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/**
 * Eval JS in the currently active tab.
 */
export async function evalJsCurrent(code, options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  const result = await evalJsInTab(tab.id, code, options);
  result.tabId = tab.id;
  result.url = tab.url;
  return result;
}

/**
 * List all open tabs (id, url, title, active). Useful for AI to pick a target.
 */
export async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    favIconUrl: t.favIconUrl || null,
  }));
}

/**
 * Get the active tab id (convenience for tools).
 */
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export { findEngine };
