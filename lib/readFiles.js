import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

/** Directory containing published package files (`lib/`, `bin/`, …) after `npm install`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXT = {
  ".txt": "text/plain",
  ".text": "text/plain",
  ".env": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Windows: skip these directory names anywhere in the tree (typical OS / installer trees). */
const WIN_SKIP_DIR_BASENAMES = new Set(
  [
    "$recycle.bin",
    "system volume information",
    "recovery",
    "windows",
    "winnt",
    "perflogs",
    "boot",
    "program files",
    "program files (x86)",
    "programdata",
    "windowsapps",
    "documents and settings",
    "inetpub",
    "msocache",
    "windows.old",
    "efi",
    "config.msi",
  ].map((s) => s.toLowerCase())
);

/** POSIX: skip paths under these roots (normalized with /). */
const UNIX_PATH_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/snap",
  "/lost+found",
  "/private/var/vm",
  "/private/var/db",
  "/System/Volumes/VM",
  "/System/Volumes/Data/private/var/vm",
  "/.Spotlight-V100",
  "/.Trashes",
  "/Volumes/.timemachine",
];

function normalizePathForCompare(absPath) {
  return path.normalize(absPath).replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * When `skipSystemDirs` is enabled, do not descend into (or collect from) these directories.
 * @param {string} absPath absolute directory path
 */
export function isPrunedSystemDirectory(absPath) {
  if (process.platform === "win32") {
    const base = path.basename(absPath).toLowerCase();
    return WIN_SKIP_DIR_BASENAMES.has(base);
  }
  const n = normalizePathForCompare(absPath);
  for (const p of UNIX_PATH_PREFIXES) {
    const q = p.replace(/\/+$/, "");
    if (n === q || n.startsWith(`${q}/`)) return true;
  }
  return false;
}

/**
 * @returns {Promise<string[]>} e.g. `["C:\\","D:\\"]` on Windows, `["/"]` elsewhere
 */
export async function listPcScanRoots() {
  if (process.platform === "win32") {
    /** @type {string[]} */
    const roots = [];
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      const root = `${letter}:\\`;
      try {
        const st = await fs.stat(root);
        if (st.isDirectory()) roots.push(root);
      } catch {
        /* not mounted */
      }
    }
    return roots;
  }
  return [path.resolve("/")];
}

/**
 * Extension / dotfile key used with {@link EXT} (handles bare `.env` where extname is "").
 * @param {string} filePath
 * @returns {string | null}
 */
function supportedExtKey(filePath) {
  const base = path.basename(filePath);
  if (base.toLowerCase() === ".env") return ".env";
  const ext = path.extname(filePath).toLowerCase();
  if (EXT[ext]) return ext;
  return null;
}

function assertSupported(filePath) {
  const ext = supportedExtKey(filePath);
  if (!ext) {
    const allowed = Object.keys(EXT).join(", ");
    throw new Error(`Unsupported file type for "${filePath}". Allowed: ${allowed}`);
  }
  return ext;
}

function supportedExtension(filePath) {
  return supportedExtKey(filePath) !== null;
}

/**
 * @param {Buffer} buffer
 */
function spreadsheetBufferToText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`## ${sheetName}\n${csv}`);
  }
  return parts.join("\n\n");
}

/**
 * Absolute paths: use as-is. Relative paths: try the installed package directory first
 * (files shipped with or placed next to this package on the machine), then the process cwd.
 */
export async function resolveReadablePath(userPath) {
  if (path.isAbsolute(userPath)) {
    const resolved = path.resolve(userPath);
    await fs.access(resolved);
    return resolved;
  }

  const candidates = [
    path.resolve(PACKAGE_ROOT, userPath),
    path.resolve(process.cwd(), userPath),
  ];

  for (const resolved of candidates) {
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      /* try next */
    }
  }

  throw new Error(
    `File not found: "${userPath}". Tried:\n  - ${candidates[0]}\n  - ${candidates[1]}`
  );
}

async function readOne(filePath) {
  const resolved = await resolveReadablePath(filePath);
  const ext = assertSupported(resolved);
  const basename = path.basename(resolved);

  if (ext === ".txt" || ext === ".text" || ext === ".env") {
    const text = await fs.readFile(resolved, "utf8");
    return {
      path: resolved,
      filename: basename,
      mimeType: EXT[ext],
      text,
    };
  }

  const buf = await fs.readFile(resolved);

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: buf });
    return {
      path: resolved,
      filename: basename,
      mimeType: EXT[ext],
      text: result.value,
      messages: result.messages?.length ? result.messages : undefined,
    };
  }

  if (ext === ".xls" || ext === ".xlsx") {
    return {
      path: resolved,
      filename: basename,
      mimeType: EXT[ext],
      text: spreadsheetBufferToText(buf),
    };
  }

  throw new Error(`Unhandled extension: ${ext}`);
}

/**
 * Turn file or directory paths into a list of supported files (directories are scanned).
 *
 * @param {string[]} paths
 * @param {{ recursive?: boolean, skipSystemDirs?: boolean }} [options]
 * @returns {Promise<string[]>} Absolute paths, sorted, de-duplicated
 */
export async function expandPathsToSupportedFiles(paths, options = {}) {
  const recursive = Boolean(options.recursive);
  const skipSystemDirs = Boolean(options.skipSystemDirs);
  const seen = new Set();
  /** @type {Set<string>} */
  const visitedRealDirs = new Set();

  /** @type {string[]} */
  const out = [];

  function remember(absPath) {
    const norm = path.normalize(absPath);
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(absPath);
  }

  async function walkDir(dir) {
    if (skipSystemDirs && isPrunedSystemDirectory(dir)) return;

    let realDir = dir;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return;
    }
    if (visitedRealDirs.has(realDir)) return;
    visitedRealDirs.add(realDir);

    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) await walkDir(full);
      } else if (supportedExtension(full)) {
        remember(full);
      }
    }
  }

  for (const p of paths) {
    const resolved = await resolveReadablePath(p);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      if (skipSystemDirs && isPrunedSystemDirectory(resolved)) continue;
      await walkDir(resolved);
    } else {
      assertSupported(resolved);
      remember(resolved);
    }
  }

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * All mounted drive roots (Windows) or `/`, recursively, skipping common system locations.
 * @param {{ skipSystemDirs?: boolean }} [options]
 */
export async function expandFullPcSupportedFiles(options = {}) {
  const skipSystemDirs = options.skipSystemDirs !== false;
  const roots = await listPcScanRoots();
  return expandPathsToSupportedFiles(roots, { recursive: true, skipSystemDirs });
}

/**
 * @param {string[]} filePaths
 * @returns {Promise<Array<{ path: string, filename: string, mimeType: string, text: string, messages?: unknown }>>}
 * For each path: absolute paths are used as-is. Relative paths try the installed
 * package directory first, then `process.cwd()`.
 */
export async function readTextAndWordFiles(filePaths) {
  const out = [];
  for (const p of filePaths) {
    out.push(await readOne(p));
  }
  return out;
}
