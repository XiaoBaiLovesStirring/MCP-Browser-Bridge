# MCP-Browser-Bridge

A pure browser extension that exposes your favorite search engines and live browser tabs as MCP tools. AI can operate web pages via JavaScript — click, fill forms, read SPA-rendered DOM, parse page JS state. Zero dependencies, no native host, no Python, no build step.

## Install

1. Download `mcp-browser-bridge-extension-v0.3.0.zip` and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, select the unzipped folder.
4. Done. Click the extension icon to open the popup, or **Settings** to configure engines.

No native messaging host, no port configuration, no external processes.

## MCP tools

| Tool | Description |
|------|-------------|
| `list_engines` | List configured search engines |
| `search` | Run a web search; returns title/url/snippet |
| `fetch_page` | Open a URL, extract page text and links |
| `get_current_page` | Extract text/links from the active tab |
| `list_tabs` | List all open tabs |
| `eval_js` | Open URL, run JS, return result, close tab |
| `eval_js_current` | Run JS in the active tab |
| `eval_js_tab` | Run JS in a specific tab by id |
| `extension_status` | Extension version, tool count, settings |

`eval_js*` tools accept a `world` parameter: `ISOLATED` (CSP-safe DOM access) or `MAIN` (page JS globals, SPA state).

## How MCP clients connect

The extension is reachable via Chrome's `externally_connectable` API. Web-based MCP clients call:

```js
chrome.runtime.sendMessage(
  EXTENSION_ID,
  { type: "mcp", payload: <json-rpc-2.0 request> },
  (resp) => console.log(resp.response);
);
```

Find your `EXTENSION_ID` on `chrome://extensions` or in the built-in **MCP Console** (open it from the popup or settings page). The console also lets you invoke any tool manually with zero setup.

## Configure

Open **Settings** to:
- Add/edit/remove search engines (Google, Bing, DuckDuckGo, Baidu templates included). URL template uses `{query}` placeholder.
- Toggle engines on/off.
- Set tab lifecycle (close or keep), max results, page load timeout.

## Project structure

```
manifest.json          MV3 manifest (v0.3.0)
background/            Service worker: MCP routing + tab orchestration + JS injection
lib/                   Built-in MCP/JSON-RPC parser, engine model, search runner, settings
content/               Current-page text/link extraction
mcp/                   Built-in MCP console (invoke tools / send raw JSON-RPC)
options/               Settings page (engines, behavior)
popup/                 Toolbar popup (status, quick search)
icons/                 16/48/128 PNG icons
```

## Security

`eval_js` runs in the real browser with the user's cookies and login state. Only connect MCP clients you trust — they can act as you on logged-in sites.

## License

MIT
