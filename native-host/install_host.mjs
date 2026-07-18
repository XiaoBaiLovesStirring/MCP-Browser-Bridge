#!/usr/bin/env node
// native-host/install_host.mjs
// Cross-platform installer for the MCP-Browser-Bridge native messaging host.
//
// Registers the host with Chrome (and optionally Chromium / Edge / Brave) so
// the extension can launch host.mjs via chrome.runtime.connectNative().
//
// Pure Node.js built-ins: fs, path, os, child_process. No Python. No npm deps.
//
// Usage:
//   node install_host.mjs           # install for current user (default)
//   node install_host.mjs --uninstall
//   node install_host.mjs --browsers chrome,edge
//   node install_host.mjs --extension-id <id>
//
// What it does:
//   1. Resolves the absolute path to host.mjs (next to this script).
//   2. Writes a launcher script (host.mjs itself is executable directly by node).
//   3. Writes the native messaging manifest JSON to the per-browser directory.
//   4. On Windows, also writes the HKCU registry key pointing at the manifest.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST_NAME = "com.mcpbrowser.bridge";

// --------------------------------------------------------------------------- //
// Argument parsing
// --------------------------------------------------------------------------- //

const args = process.argv.slice(2);
let doUninstall = false;
let browsersArg = null;
let extensionIdArg = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--uninstall" || a === "-u") {
    doUninstall = true;
  } else if (a === "--browsers") {
    browsersArg = args[++i];
  } else if (a === "--extension-id") {
    extensionIdArg = args[++i];
  } else if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(1);
  }
}

function printHelp() {
  console.log(`MCP-Browser-Bridge native host installer

Usage:
  node install_host.mjs [options]

Options:
  --uninstall, -u           Remove the host registration (default: install).
  --browsers <list>         Comma-separated browser list to install for.
                            Default: chrome
                            Supported: chrome, chromium, edge, brave, vivaldi
  --extension-id <id>       Allow this specific extension id to connect.
                            (Otherwise allow any extension that has the
                             nativeMessaging permission and matches the
                             allowed_origins below; you usually do NOT need
                             this — set it in the manifest below.)
  --help, -h                Show this help.

What gets installed:
  - A native messaging manifest JSON (per browser) that tells Chrome where
    to find host.mjs and which extension ids may connect.
  - On Windows, also a HKCU registry key pointing at the manifest.
`);
}

// --------------------------------------------------------------------------- //
// Platform / browser target directories
// --------------------------------------------------------------------------- //

const platform = process.platform; // 'win32' | 'darwin' | 'linux'
const home = os.homedir();

function browserManifestDirs(browser) {
  if (platform === "win32") {
    // On Windows, the manifest path is stored in the registry; any directory
    // works. We use %LOCALAPPDATA%\<browser>\NativeMessagingHosts for parity.
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(localAppData, browser, "User Data", "NativeMessagingHosts"),
    ];
  }
  if (platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    switch (browser) {
      case "chrome":   return [path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts")];
      case "chromium": return [path.join(appSupport, "Chromium", "NativeMessagingHosts")];
      case "edge":     return [path.join(appSupport, "Microsoft Edge", "NativeMessagingHosts")];
      case "brave":    return [path.join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")];
      case "vivaldi":  return [path.join(appSupport, "Vivaldi", "NativeMessagingHosts")];
      default: return [];
    }
  }
  // Linux
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  switch (browser) {
    case "chrome":   return [path.join(config, "google-chrome", "NativeMessagingHosts")];
    case "chromium": return [path.join(config, "chromium", "NativeMessagingHosts")];
    case "edge":     return [path.join(config, "microsoft-edge", "NativeMessagingHosts")];
    case "brave":    return [path.join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")];
    case "vivaldi":  return [path.join(config, "vivaldi", "NativeMessagingHosts")];
    default: return [];
  }
}

function browserRegistryKey(browser) {
  switch (browser) {
    case "chrome":   return "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
    case "chromium": return "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + HOST_NAME;
    case "edge":     return "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME;
    case "brave":    return "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + HOST_NAME;
    case "vivaldi":  return "HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\" + HOST_NAME;
    default: return null;
  }
}

const BROWSERS_DEFAULT = ["chrome"];
const BROWSERS_SUPPORTED = ["chrome", "chromium", "edge", "brave", "vivaldi"];
const browsers = (browsersArg ? browsersArg.split(",").map((s) => s.trim()).filter(Boolean) : BROWSERS_DEFAULT)
  .map((b) => b.toLowerCase());
for (const b of browsers) {
  if (!BROWSERS_SUPPORTED.includes(b)) {
    console.error(`Unsupported browser: ${b}. Supported: ${BROWSERS_SUPPORTED.join(", ")}`);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------- //
// Locate node executable (for the manifest's "path" field on Windows we need
// a wrapper batch; on macOS/Linux we can pass node + script directly).
// --------------------------------------------------------------------------- //

function findNode() {
  // Prefer the node currently running this script.
  if (process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  return null;
}

const NODE_BIN = findNode();
if (!NODE_BIN) {
  console.error("Could not locate the node executable. Please run this script with node directly.");
  process.exit(1);
}

const HOST_SCRIPT = path.resolve(__dirname, "host.mjs");
if (!fs.existsSync(HOST_SCRIPT)) {
  console.error(`host.mjs not found next to installer: ${HOST_SCRIPT}`);
  process.exit(1);
}

// --------------------------------------------------------------------------- //
// Build the manifest
// --------------------------------------------------------------------------- //
//
// The manifest's "path" must be:
//   - macOS / Linux: the path to the executable. We pass node and host.mjs
//     via the "path" + "args" fields.
//   - Windows: a single executable path. node.exe + script can't be split in
//     the manifest, so we write a small .cmd wrapper and point at it.

let manifestPathField;
let manifestArgsField;
let wrapperPath = null;

if (platform === "win32") {
  wrapperPath = path.join(__dirname, "run-host.cmd");
  const nodeWin = NODE_BIN.replace(/\//g, "\\");
  const scriptWin = HOST_SCRIPT.replace(/\//g, "\\");
  // Use forward slashes inside the batch file content; the cmd interpreter
  // accepts both, but we keep backslashes for clarity.
  const wrapper = `@echo off\r\n"${nodeWin}" "${scriptWin}" %*\r\n`;
  fs.writeFileSync(wrapperPath, wrapper, "utf8");
  manifestPathField = wrapperPath;
  manifestArgsField = [];
} else {
  manifestPathField = NODE_BIN;
  manifestArgsField = [HOST_SCRIPT];
}

// By default allow any extension that has nativeMessaging permission. Chrome
// still requires the extension id to be listed in allowed_origins as
// chrome-extension://<id>/. Since the id is generated per install, we expose
// a placeholder. The user can pass --extension-id to lock it down.
const allowedOrigins = extensionIdArg
  ? [`chrome-extension://${extensionIdArg}/`]
  : []; // empty => Chrome will reject. We instead use the wildcard trick below.

// Chrome does NOT support wildcards in allowed_origins. The user must list
// their actual extension id. If --extension-id was not given, we leave
// allowed_origins empty and warn the user. As a convenience, we also try to
// read the extension id from a sibling file `extension_id.txt` if present.
let finalAllowedOrigins = allowedOrigins;
if (finalAllowedOrigins.length === 0) {
  const idFile = path.join(__dirname, "extension_id.txt");
  if (fs.existsSync(idFile)) {
    const id = fs.readFileSync(idFile, "utf8").trim();
    if (id) {
      finalAllowedOrigins = [`chrome-extension://${id}/`];
      console.log(`Using extension id from extension_id.txt: ${id}`);
    }
  }
}

function buildManifest() {
  return {
    name: HOST_NAME,
    description: "MCP-Browser-Bridge native messaging host",
    path: manifestPathField,
    type: "stdio",
    allowed_origins: finalAllowedOrigins,
  };
}

// --------------------------------------------------------------------------- //
// Install / uninstall
// --------------------------------------------------------------------------- //

function installForBrowser(browser) {
  const dirs = browserManifestDirs(browser);
  if (dirs.length === 0) {
    console.warn(`  (${browser}) no manifest directory on this platform; skipping`);
    return;
  }
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    const manifestFile = path.join(dir, `${HOST_NAME}.json`);
    const manifest = buildManifest();
    manifest.args = manifestArgsField;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`  [${browser}] manifest written: ${manifestFile}`);

    if (platform === "win32") {
      const regKey = browserRegistryKey(browser);
      if (regKey) {
        const manifestWin = manifestFile.replace(/\//g, "\\");
        try {
          execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestWin}" /f`, { stdio: "pipe" });
          console.log(`  [${browser}] registry key set: ${regKey}`);
        } catch (e) {
          console.warn(`  [${browser}] failed to set registry key: ${e.message}`);
        }
      }
    }
  }
}

function uninstallForBrowser(browser) {
  const dirs = browserManifestDirs(browser);
  for (const dir of dirs) {
    const manifestFile = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(manifestFile)) {
      fs.unlinkSync(manifestFile);
      console.log(`  [${browser}] removed: ${manifestFile}`);
    } else {
      console.log(`  [${browser}] not installed (no manifest at ${manifestFile})`);
    }
    if (platform === "win32") {
      const regKey = browserRegistryKey(browser);
      if (regKey) {
        try {
          execSync(`reg delete "${regKey}" /f`, { stdio: "ignore" });
          console.log(`  [${browser}] registry key removed: ${regKey}`);
        } catch (_) {
          // not present, ignore
        }
      }
    }
  }
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //

console.log(`MCP-Browser-Bridge native host ${doUninstall ? "uninstaller" : "installer"}`);
console.log(`  platform : ${platform}`);
console.log(`  node     : ${NODE_BIN}`);
console.log(`  host.mjs : ${HOST_SCRIPT}`);
console.log(`  browsers : ${browsers.join(", ")}`);
if (wrapperPath) console.log(`  wrapper  : ${wrapperPath}`);
if (finalAllowedOrigins.length > 0) {
  console.log(`  allowed_origins: ${finalAllowedOrigins.join(", ")}`);
} else {
  console.log(`  allowed_origins: (none — see warning below)`);
}
console.log("");

if (doUninstall) {
  for (const b of browsers) uninstallForBrowser(b);
  // Also remove the wrapper if we created it.
  if (wrapperPath && fs.existsSync(wrapperPath)) {
    try { fs.unlinkSync(wrapperPath); console.log(`  removed wrapper: ${wrapperPath}`); } catch (_) {}
  }
  console.log("\nUninstall complete.");
  process.exit(0);
}

for (const b of browsers) installForBrowser(b);

console.log("");
if (finalAllowedOrigins.length === 0) {
  console.log("WARNING: No extension id was provided. Chrome will refuse to");
  console.log("connect to the host. You must do ONE of the following:");
  console.log("");
  console.log("  1. Re-run with your extension id:");
  console.log("       node install_host.mjs --extension-id <YOUR_EXTENSION_ID>");
  console.log("");
  console.log("  2. Or write the id to a file and re-run:");
  console.log("       echo <YOUR_EXTENSION_ID> > native-host/extension_id.txt");
  console.log("       node install_host.mjs");
  console.log("");
  console.log("You can find the extension id at chrome://extensions after");
  console.log("loading the unpacked extension.");
  console.log("");
}
console.log("Done. Restart Chrome (or reload the extension) for changes to take effect.");
console.log("");
console.log("To verify, load the extension in Chrome, then check chrome://extensions");
console.log("for the MCP-Browser-Bridge service worker logs. The native host listens");
console.log("on http://127.0.0.1:7777 (override with MCPBB_PORT env var).");
