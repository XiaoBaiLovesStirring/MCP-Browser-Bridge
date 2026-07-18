// content/content.js
// Lightweight content script. Listens for extraction requests on the current
// page and returns structured text + links. The background service worker can
// also inject extraction via chrome.scripting, but this content script enables
// popup-driven "extract this page" without round-tripping through the worker.

(function () {
  "use strict";

  function extractLinks(max) {
    const out = [];
    const seen = new Set();
    const anchors = document.querySelectorAll("a[href]");
    for (let i = 0; i < anchors.length && out.length < max; i++) {
      const a = anchors[i];
      const href = a.href;
      if (!href || seen.has(href)) continue;
      if (href.startsWith("javascript:") || href.startsWith("#") || href.startsWith("mailto:")) continue;
      seen.add(href);
      out.push({ text: (a.textContent || "").trim(), url: href });
    }
    return out;
  }

  function extractText() {
    // Prefer innerText for human-readable layout, fall back to textContent.
    if (document.body && typeof document.body.innerText === "string") {
      return document.body.innerText;
    }
    return document.documentElement.textContent || "";
  }

  function extractPage(maxLinks) {
    const text = extractText();
    return {
      url: location.href,
      title: document.title,
      text,
      textLength: text.length,
      links: extractLinks(maxLinks || 50),
      linkCount: 0, // filled below
      extractedAt: new Date().toISOString(),
    };
  }

  // Recognize headings and main content blocks for smarter "text recognition".
  function extractStructure() {
    const headings = [];
    document.querySelectorAll("h1, h2, h3").forEach((h) => {
      const t = (h.textContent || "").trim();
      if (t) headings.push({ level: Number(h.tagName.slice(1)), text: t });
    });
    const mains = [];
    document.querySelectorAll("main, article, [role=main]").forEach((m) => {
      const t = (m.innerText || "").trim();
      if (t) mains.push({ tag: m.tagName.toLowerCase(), text: t.slice(0, 2000) });
    });
    return { headings, mainBlocks: mains };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "extract-current": {
        const data = extractPage(msg.maxLinks || 50);
        data.linkCount = data.links.length;
        try { Object.assign(data, extractStructure()); } catch (_) {}
        sendResponse({ ok: true, data });
        break;
      }
      case "ping":
        sendResponse({ ok: true, url: location.href, title: document.title });
        break;
      default:
        // Not our message; ignore.
        break;
    }
    return true; // async-safe
  });
})();
