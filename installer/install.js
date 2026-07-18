// installer/install.js
// Standalone .cxr installer. No dependencies, no build step.
//
// .cxr format = a standard ZIP archive containing:
//   - all extension files (manifest.json, background/, lib/, ...)
//   - .cxr-manifest.json  (format signature + metadata)
//
// The installer:
//   1. Parses the ZIP in pure JS (EOCD -> central directory -> local headers)
//   2. Decompresses entries via DecompressionStream('deflate-raw') (Chrome 105+)
//   3. Validates the .cxr-manifest.json signature
//   4. Writes files to a user-picked folder via File System Access API
//   5. Falls back to manual instructions if any API is unavailable

const I18N = {
  en: {
    subtitle: 'Drop a <code>.cxr</code> package to install the extension.',
    dropTitle: "Drag your .cxr file here",
    dropHint: "or click to browse",
    packageInfo: "Package information",
    format: "Format",
    extVersion: "Extension version",
    buildDate: "Build date",
    fileCount: "File count",
    contents: "Contents",
    install: "Install to folder…",
    openExtensions: "Open chrome://extensions",
    reset: "Reset",
    manualTitle: "Manual fallback",
    manualHint: "If the installer button doesn't work (older browsers), you can still install manually:",
    step1: 'Rename <code>.cxr</code> to <code>.zip</code> (or just extract the <code>.cxr</code> directly — it\'s a standard ZIP).',
    step2: "Unzip it to any folder.",
    step3: "Open <code>chrome://extensions</code>, enable <b>Developer mode</b>, click <b>Load unpacked</b>, select the folder.",
    errNotCxr: "This file is not a valid .cxr package (missing .cxr-manifest.json).",
    errParse: "Failed to parse the ZIP archive: ",
    errRead: "Failed to read the file: ",
    errUnsupported: "Your browser doesn't support the File System Access API. Please use the manual fallback below (rename to .zip and extract).",
    errWrite: "Failed to write a file: ",
    pickFolder: "Pick the destination folder",
    writing: "Writing files…",
    success: "Done! Files written to your folder. Now open chrome://extensions, enable Developer mode, click \"Load unpacked\", and select that folder.",
    partialFail: "Some files failed to write. See the manual fallback below.",
  },
  zh: {
    subtitle: '拖入 <code>.cxr</code> 安装包即可安装扩展。',
    dropTitle: "把 .cxr 文件拖到这里",
    dropHint: "或点击选择文件",
    packageInfo: "安装包信息",
    format: "格式",
    extVersion: "扩展版本",
    buildDate: "构建日期",
    fileCount: "文件数",
    contents: "内容",
    install: "安装到文件夹…",
    openExtensions: "打开 chrome://extensions",
    reset: "重置",
    manualTitle: "手动备选方案",
    manualHint: "如果安装按钮不可用（旧版浏览器），也可以手动安装：",
    step1: '把 <code>.cxr</code> 重命名为 <code>.zip</code>（或直接解压 <code>.cxr</code>——它就是标准 ZIP）。',
    step2: "解压到任意文件夹。",
    step3: "打开 <code>chrome://extensions</code>，开启<b>开发者模式</b>，点击<b>加载已解压的扩展程序</b>，选择该文件夹。",
    errNotCxr: "该文件不是有效的 .cxr 安装包（缺少 .cxr-manifest.json）。",
    errParse: "解析 ZIP 失败：",
    errRead: "读取文件失败：",
    errUnsupported: "你的浏览器不支持文件系统访问 API，请使用下方手动方案（重命名为 .zip 后解压）。",
    errWrite: "写入文件失败：",
    pickFolder: "选择目标文件夹",
    writing: "正在写入文件…",
    success: "完成！文件已写入你选择的文件夹。现在打开 chrome://extensions，开启开发者模式，点击「加载已解压的扩展程序」，选择该文件夹。",
    partialFail: "部分文件写入失败，请参考下方手动方案。",
  },
};

let currentLang = "en";
let parsedEntries = null; // [{name, compressed, method, crc, uncompressedSize, dataOffset}]
let cxrMeta = null;
let fileCount = 0;

const $ = (id) => document.getElementById(id);

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    // Allow inline HTML (code, b) in translations.
    el.innerHTML = val;
  });
}

function setLang(lang) {
  currentLang = lang === "zh" ? "zh" : "en";
  document.querySelectorAll(".lang").forEach((b) => {
    b.classList.toggle("active", b.dataset.lang === currentLang);
  });
  applyI18n();
}

// --------------------------------------------------------------------------- //
// Minimal ZIP reader (pure JS, no deps)
// --------------------------------------------------------------------------- //

async function parseZip(buffer) {
  // buffer: ArrayBuffer
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Find End of Central Directory record (EOCD). Signature: 0x06054b50.
  // Scan backwards from the end, allowing for a comment up to 65535 bytes.
  const minEocd = 22;
  const maxComment = 65535;
  const scanStart = Math.max(0, bytes.length - minEocd - maxComment);
  let eocdOffset = -1;
  for (let i = bytes.length - minEocd; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found — not a ZIP file");

  const cdCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Resolve the actual data offset by reading the local file header.
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error("bad local file header for " + name);
    }
    const lNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lNameLen + lExtraLen;

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      dataOffset,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function decompressEntry(buffer, entry) {
  const bytes = new Uint8Array(buffer);
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    // Stored, no compression.
    return compressed.slice(0, entry.uncompressedSize);
  }
  if (entry.method !== 8) {
    throw new Error("unsupported compression method " + entry.method + " for " + entry.name);
  }
  // DEFLATE (raw). Use DecompressionStream (Chrome 105+, Firefox 113+).
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream not supported in this browser");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// File System Access API writer
// --------------------------------------------------------------------------- //

function supportsDirPicker() {
  return typeof window.showDirectoryPicker === "function";
}

async function writeEntriesToDir(dirHandle, entries, buffer) {
  let failures = 0;
  for (const entry of entries) {
    // Skip directory entries (names ending with /).
    if (entry.name.endsWith("/")) continue;
    // Skip the .cxr-manifest.json marker — it's not part of the loaded extension.
    if (entry.name === ".cxr-manifest.json") continue;
    try {
      const data = await decompressEntry(buffer, entry);
      // Walk into subdirectories, creating them as needed.
      const parts = entry.name.split("/").filter(Boolean);
      let cur = dirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i], { create: true });
      }
      const fileName = parts[parts.length - 1];
      const fileHandle = await cur.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    } catch (e) {
      console.error("failed to write", entry.name, e);
      failures++;
    }
  }
  return failures;
}

// --------------------------------------------------------------------------- //
// UI flow
// --------------------------------------------------------------------------- //

function buildFileTree(entries) {
  // Render a simple indented tree.
  const lines = [];
  const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sorted) {
    const depth = e.name.split("/").length - 1;
    const indent = "  ".repeat(depth);
    const isDir = e.name.endsWith("/");
    const label = isDir ? e.name.slice(e.name.lastIndexOf("/", e.name.length - 2) + 1) : e.name.split("/").pop();
    if (isDir) {
      lines.push(`${indent}${label}/`);
    } else {
      const sizeStr = e.uncompressedSize < 1024
        ? `${e.uncompressedSize} B`
        : `${(e.uncompressedSize / 1024).toFixed(1)} KB`;
      lines.push(`${indent}${label}  (${sizeStr})`);
    }
  }
  return lines.join("\n");
}

async function handleFile(file) {
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    showStatus("err", t("errRead") + e.message);
    return;
  }

  let entries;
  try {
    entries = await parseZip(buffer);
  } catch (e) {
    showStatus("err", t("errParse") + e.message);
    return;
  }

  // Find the .cxr-manifest.json. It may be at the root, or inside a top-level folder.
  let metaEntry = entries.find((e) => e.name === ".cxr-manifest.json" || e.name.endsWith("/.cxr-manifest.json"));
  if (!metaEntry) {
    showStatus("err", t("errNotCxr"));
    return;
  }

  try {
    const metaBytes = await decompressEntry(buffer, metaEntry);
    cxrMeta = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch (e) {
    showStatus("err", t("errParse") + e.message);
    return;
  }

  parsedEntries = entries;
  fileCount = entries.filter((e) => !e.name.endsWith("/")).length;

  // Populate info card.
  $("infoFormat").textContent = cxrMeta.format || ".cxr v1";
  $("infoVersion").textContent = cxrMeta.extensionVersion || "—";
  $("infoDate").textContent = cxrMeta.buildDate || "—";
  $("infoFiles").textContent = String(fileCount);
  $("fileTree").textContent = buildFileTree(entries);

  $("infoCard").hidden = false;
  $("infoCard").scrollIntoView({ behavior: "smooth", block: "start" });

  // Enable/disable install button based on API support.
  $("installBtn").disabled = !supportsDirPicker();
  if (!supportsDirPicker()) {
    $("installBtn").title = t("errUnsupported");
  }
}

async function installToFolder() {
  if (!parsedEntries) return;
  if (!supportsDirPicker()) {
    showStatus("err", t("errUnsupported"));
    return;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    // User cancelled.
    return;
  }
  showStatus("", t("writing"));
  // Buffer needs to be re-read since parsedEntries reference offsets into it.
  // We kept parsedEntries but not the buffer; re-fetch from the last file.
  // To keep it simple, re-read from the input file.
  // (We stash the last buffer on the file input handler.)
  const buffer = lastBuffer;
  if (!buffer) {
    showStatus("err", "internal: buffer lost");
    return;
  }
  const failures = await writeEntriesToDir(dirHandle, parsedEntries, buffer);
  if (failures === 0) {
    showStatus("ok", t("success"));
  } else {
    showStatus("err", `${t("partialFail")} (${failures} failed)`);
  }
}

let lastBuffer = null;

function showStatus(kind, msg) {
  const el = $("installStatus");
  el.hidden = false;
  el.className = "status " + (kind || "");
  el.textContent = msg;
}

function reset() {
  parsedEntries = null;
  cxrMeta = null;
  $("infoCard").hidden = true;
  $("installStatus").hidden = true;
  $("fileInput").value = "";
}

// --------------------------------------------------------------------------- //
// Wire up
// --------------------------------------------------------------------------- //

function bindEvents() {
  document.querySelectorAll(".lang").forEach((b) => {
    b.addEventListener("click", () => setLang(b.dataset.lang));
  });

  const dz = $("dropZone");
  const input = $("fileInput");
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) {
      lastBuffer = await f.arrayBuffer();
      await handleFile(f);
    }
  });
  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  dz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (f) {
      lastBuffer = await f.arrayBuffer();
      await handleFile(f);
    }
  });

  $("installBtn").addEventListener("click", installToFolder);
  $("openChrome").addEventListener("click", () => {
    window.open("chrome://extensions", "_blank");
  });
  $("resetBtn").addEventListener("click", reset);
}

// Detect user language on first load.
(function init() {
  const nav = (navigator.language || "en").toLowerCase();
  currentLang = nav.startsWith("zh") ? "zh" : "en";
  setLang(currentLang);
  bindEvents();
})();
