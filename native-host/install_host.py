#!/usr/bin/env python3
"""
Install the MCP-Browser-Bridge native messaging host.

Usage:
    python3 install_host.py --extension-id <EXTENSION_ID>
    python3 install_host.py --uninstall

Steps performed:
  1. Creates a small launcher (shell script on Linux/macOS, .bat on Windows)
     that runs host.py with the correct Python interpreter.
  2. Generates the native messaging manifest (com.mcpbrowser.bridge.json)
     with the provided extension ID in allowed_origins.
  3. Installs the manifest:
       - Linux:   ~/.config/google-chrome/NativeMessagingHosts/  (+chromium)
       - macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
       - Windows: %LOCALAPPDATA%\\MCPBrowserBridge\\ + HKCU registry key

After installing, reload the extension in chrome://extensions.
"""
import argparse
import json
import os
import platform
import stat
import sys

HOST_NAME = "com.mcpbrowser.bridge"


def here():
    return os.path.dirname(os.path.abspath(__file__))


def find_python():
    """Return a python executable suitable for running host.py."""
    for candidate in ("python3", "python"):
        if _which(candidate):
            return candidate
    return sys.executable or "python"


def _which(cmd):
    paths = os.environ.get("PATH", "").split(os.pathsep)
    for p in paths:
        full = os.path.join(p, cmd)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            return full
    return None


def make_launcher(host_py, system):
    """Create a launcher script and return its absolute path."""
    py = find_python()
    if system == "Windows":
        launcher_path = os.path.join(here(), "host_launcher.bat")
        with open(launcher_path, "w", newline="") as f:
            f.write(f'@echo off\r\n"{py}" "{host_py}" %*\r\n')
        return launcher_path
    launcher_path = os.path.join(here(), "host_launcher.sh")
    with open(launcher_path, "w") as f:
        f.write(f'#!/bin/sh\nexec "{py}" "{host_py}" "$@"\n')
    os.chmod(launcher_path, 0o755 | stat.S_IRGRP | stat.S_IROTH)
    return launcher_path


def build_manifest(launcher_path, extension_id):
    return {
        "name": HOST_NAME,
        "description": "MCP-Browser-Bridge native messaging host",
        "path": launcher_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def unix_target_dirs():
    home = os.path.expanduser("~")
    system = platform.system()
    if system == "Darwin":
        return [os.path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts")]
    # Linux
    return [
        os.path.join(home, ".config/google-chrome/NativeMessagingHosts"),
        os.path.join(home, ".config/chromium/NativeMessagingHosts"),
    ]


def install_unix(manifest):
    written = []
    for d in unix_target_dirs():
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            continue
        path = os.path.join(d, HOST_NAME + ".json")
        with open(path, "w") as f:
            json.dump(manifest, f, indent=2)
        written.append(path)
    return written


def install_windows(manifest):
    import winreg  # type: ignore
    local_app = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    manifest_dir = os.path.join(local_app, "MCPBrowserBridge")
    os.makedirs(manifest_dir, exist_ok=True)
    manifest_path = os.path.join(manifest_dir, HOST_NAME + ".json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    key_path = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, manifest_path)
    return [manifest_path]


def uninstall_unix():
    removed = []
    for d in unix_target_dirs():
        path = os.path.join(d, HOST_NAME + ".json")
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    return removed


def uninstall_windows():
    import winreg  # type: ignore
    key_path = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        return ["HKCU\\" + key_path]
    except FileNotFoundError:
        return []


def main():
    ap = argparse.ArgumentParser(description="Install MCP-Browser-Bridge native host.")
    ap.add_argument("--extension-id", help="Chrome extension ID (from chrome://extensions).")
    ap.add_argument("--uninstall", action="store_true", help="Remove the native host registration.")
    args = ap.parse_args()

    system = platform.system()

    if args.uninstall:
        removed = uninstall_windows() if system == "Windows" else uninstall_unix()
        if removed:
            print("Removed:")
            for p in removed:
                print("  - " + p)
        else:
            print("Nothing to remove.")
        return

    if not args.extension_id:
        ap.error("--extension-id is required. Load the unpacked extension in chrome://extensions, "
                 "copy its 32-char ID, and pass it here.")

    ext_id = args.extension_id.strip()
    if not (len(ext_id) == 32 and all(c.isalnum() for c in ext_id)):
        ap.error("extension ID looks invalid (expected 32 alphanumeric chars).")

    host_py = os.path.join(here(), "host.py")
    if not os.path.exists(host_py):
        ap.error(f"host.py not found next to this script: {host_py}")

    launcher_path = make_launcher(host_py, system)
    manifest = build_manifest(launcher_path, ext_id)

    if system == "Windows":
        written = install_windows(manifest)
    else:
        written = install_unix(manifest)

    print("Native messaging host installed.")
    print(f"  Launcher:    {launcher_path}")
    print(f"  Host script: {host_py}")
    print(f"  Extension:   {ext_id}")
    print("  Manifest(s):")
    for p in written:
        print("    - " + p)
    print("\nNext: reload the extension in chrome://extensions, then open the extension options "
          "and click Reconnect.")


if __name__ == "__main__":
    main()
