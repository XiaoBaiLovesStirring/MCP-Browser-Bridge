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

export { findEngine };
