# MCP-Browser-Bridge

A Chrome MV3 extension that exposes your favorite search engines and live browser tabs as MCP tools. AI can operate web pages via JavaScript — click, fill forms, read SPA-rendered DOM, parse page JS state. Optional pure-Node.js native host opens a local HTTP/SSE port (default `127.0.0.1:7777`) so desktop MCP clients (Claude Desktop, Cursor, etc.) can connect. Zero npm dependencies, no Python, no build step.

## Install

### 1. Load the extension

1. Download `mcp-browser-bridge-extension-v0.6.0.zip` (or the `.cxr` package) and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, select the unzipped folder.
4. Note your extension id on `chrome://extensions` — you need it for step 2.

### 2. (Optional) Install the native host to open a local port

Desktop MCP clients (Claude Desktop, Cursor, Cline, etc.) connect over HTTP/SSE on `127.0.0.1:7777`. To enable this:

1. Install Node.js 18+ from <https://nodejs.org/>.
2. Download `mcp-browser-bridge-native-host-v0.6.0.zip` and unzip it anywhere.
3. Run the installer with your extension id:

   ```sh
   node install_host.mjs --extension-id <YOUR_EXTENSION_ID>
   ```

   Add `--browsers chrome,edge` to install for multiple browsers.
4. Reload the extension on `chrome://extensions`. The bridge auto-connects and the host starts listening on `127.0.0.1:7777`.

Web-based MCP clients do **not** need the native host — they call the extension directly via `externally_connectable`.

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
| `bridge_status` | Native host bridge status and client endpoints |
| `extension_status` | Extension version, tool count, settings, bridge status |

`eval_js*` tools accept a `world` parameter: `ISOLATED` (CSP-safe DOM access) or `MAIN` (page JS globals, SPA state).

## How MCP clients connect

### Desktop clients (Claude Desktop, Cursor, etc.)

After installing the native host, point your client at one of these URLs:

- **Streamable HTTP** (MCP 2025-06-18): `http://127.0.0.1:7777/mcp`
- **Legacy SSE** (MCP 2024-11-05): `http://127.0.0.1:7777/sse`
- **Health check**: `http://127.0.0.1:7777/health`

Both transports are served simultaneously, so any MCP client works.

### Web-based clients

The extension is reachable via Chrome's `externally_connectable` API:

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
- Configure the native host: host, port, transport, auto-connect on startup. Copy client endpoint URLs with one click.

The settings page, popup, and MCP console all have an **EN / 中文** language switcher in the top-left.

## Override the port

The host reads `MCPBB_PORT` from the environment (default `7777`):

```sh
MCPBB_PORT=8888 node host.mjs
```

Then update the port in the extension's settings page to match.

## Project structure

```
manifest.json          MV3 manifest (v0.6.0)
background/            Service worker: MCP routing + tab orchestration + JS injection + bridge
lib/                   MCP/JSON-RPC parser, engine model, search runner, settings, bridge, i18n
content/               Current-page text/link extraction
mcp/                   Built-in MCP console (invoke tools / send raw JSON-RPC)
options/               Settings page (engines, behavior, native host bridge)
popup/                 Toolbar popup (status, bridge status, quick search)
icons/                 16/48/128 PNG icons
native-host/           Pure Node.js native messaging host + cross-platform installer
installer/             Standalone .cxr installer (pure JS, File System Access API)
```

## Security

`eval_js` runs in the real browser with the user's cookies and login state. Only connect MCP clients you trust — they can act as you on logged-in sites. The native host binds to `127.0.0.1` only, so it is not reachable from other machines.

## License

MIT
