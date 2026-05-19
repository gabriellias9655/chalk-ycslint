import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { getDriveNameForPath, getDriveNameMap } from "./driveNames.js";

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

/**
 * Directory basenames to skip during full PC scan (--scan-pc) and when
 * --skip-system-dirs is set. Matched case-insensitively on all platforms.
 */
const SKIP_DIR_BASENAMES = new Set(
  [
    // OS / installer (Windows)
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
    "library",
    "system",
    "appdata",
    // Full-scan skips: dev trees, caches, media, VCS, tooling
    "node_modules",
    "build",
    "dist",
    "out",
    "output",
    "release",
    "bin",
    "obj",
    "debug",
    "target",
    "target2",
    "public",
    "private",
    "tmp",
    "temp",
    "var",
    "cache",
    "log",
    "logs",
    "sample",
    "samples",
    "assets",
    "media",
    "fonts",
    "icons",
    "images",
    "img",
    "static",
    "resources",
    "svn",
    "cvs",
    "hg",
    "mercurial",
    "registry",
    "__macosx",
    "vscode",
    "eslint",
    "prettier",
    "yarn",
    "pnpm",
    "next",
    "pkg",
    "move",
    "rustup",
    "toolchains",
    "migrations",
    "snapshots",
    "ssh",
    "socket.io",
    "svelte-kit",
    "vite",
    "coverage",
    "history",
    "terraform",
    // VCS / package caches (large, not user documents)
    ".git",
    ".github",
    ".npm",
    ".nuget",
    ".cargo",
    ".gradle",
    ".m2",
    ".venv",
    ".tox",
    "vendor",
    "bower_components",
    "site-packages",
    // Cloud sync / game libraries
    "onedrive",
    "dropbox",
    "google drive",
    "steamapps",
    "epic games",
    "xboxgames",
    // OS / vendor trees often under Users or drive root
    "winsxs",
    "servicing",
    "driverstore",
    "assembly",
    "microsoft",
    "msbuild",
    "packages",
    "installer",
    "backup",
    "backups",
    "iso",
    "isos",
  ].map((s) => s.toLowerCase())
);

/** Max directories walked at once (per drive / subtree). */
const WALK_CONCURRENCY = 16;

/** Skip paths under these roots on macOS (normalized with /). */
const DARWIN_PATH_PREFIXES = [
  "/System",
  "/private",
  "/Applications",
  "/Library",
  "/cores",
  "/dev",
  "/net",
  "/opt",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/.Spotlight-V100",
  "/.Trashes",
  "/.fseventsd",
  "/.DocumentRevisions-V100",
];

/** Skip paths under these roots on Linux and other Unix (normalized with /). */
const UNIX_PATH_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/snap",
  "/lost+found",
  "/usr",
  "/lib",
  "/lib64",
  "/boot",
  "/etc",
  "/opt",
  "/root",
  "/sbin",
  "/bin",
  "/srv",
  "/var",
  "/private/var/vm",
  "/private/var/db",
  "/System/Volumes/VM",
  "/System/Volumes/Data/private/var/vm",
  "/.Spotlight-V100",
  "/.Trashes",
  "/Volumes/.timemachine",
];

/** macOS volume names under /Volumes to skip (system / backup volumes). */
const DARWIN_SKIP_VOLUME_NAMES = new Set(
  [
    "macintosh hd",
    "macintosh hd - data",
    "preboot",
    "recovery",
    "vm",
    "updates",
    "timemachine",
    ".timemachine",
  ].map((s) => s.toLowerCase())
);

function normalizePathForCompare(absPath) {
  return path.normalize(absPath).replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * @param {string} absPath
 * @returns {string[]}
 */
function pathSegmentsForPrune(absPath) {
  return normalizePathForCompare(absPath).toLowerCase().split("/").filter(Boolean);
}

/**
 * When `skipSystemDirs` is enabled, do not descend into (or collect from) these directories.
 * Matches any path segment (e.g. skips `C:\Windows\...` entirely, not only a leaf named `windows`).
 * @param {string} absPath absolute directory path
 */
export function isPrunedSystemDirectory(absPath) {
  for (const seg of pathSegmentsForPrune(absPath)) {
    if (SKIP_DIR_BASENAMES.has(seg)) return true;
  }

  const n = normalizePathForCompare(absPath);
  const prefixes =
    process.platform === "darwin"
      ? DARWIN_PATH_PREFIXES
      : process.platform !== "win32"
        ? UNIX_PATH_PREFIXES
        : [];

  for (const p of prefixes) {
    const q = p.replace(/\/+$/, "");
    if (n === q || n.startsWith(`${q}/`)) return true;
  }
  return false;
}

/**
 * @param {string[]} roots
 * @param {string} dirPath
 */
async function pushRootIfDirectory(roots, dirPath) {
  try {
    const st = await fs.stat(dirPath);
    if (st.isDirectory()) roots.push(path.resolve(dirPath));
  } catch {
    /* missing or permission denied */
  }
}

/**
 * @param {string[]} roots
 * @param {string} parent
 * @param {{ skipVolumeNames?: Set<string> }} [options]
 */
async function pushChildDirectoryRoots(roots, parent, options = {}) {
  const skipNames = options.skipVolumeNames;
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(parent, ent.name);
    if (skipNames?.has(ent.name.toLowerCase())) continue;
    if (isPrunedSystemDirectory(full)) continue;
    if (ent.isDirectory()) {
      await pushRootIfDirectory(roots, full);
      continue;
    }
    if (ent.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) await pushRootIfDirectory(roots, full);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Scan roots for --scan-pc:
 * - Windows: drive letters J:…C:
 * - macOS: /Users plus mounted volumes under /Volumes
 * - Linux: /home plus /media and /mnt
 * @returns {Promise<string[]>}
 */
export async function listPcScanRoots() {
  if (process.platform === "win32") {
    /** @type {string[]} */
    const roots = [];
    const maxLetter = "J".charCodeAt(0) - 65;
    const minLetter = "C".charCodeAt(0) - 65;
    const letters = [];
    for (let i = maxLetter; i >= minLetter; i--) letters.push(i);
    const found = await Promise.all(
      letters.map(async (i) => {
        const root = `${String.fromCharCode(65 + i)}:\\`;
        try {
          const st = await fs.stat(root);
          return st.isDirectory() ? root : null;
        } catch {
          return null;
        }
      })
    );
    for (const root of found) {
      if (root) roots.push(root);
    }
    return roots;
  }

  /** @type {string[]} */
  const roots = [];

  if (process.platform === "darwin") {
    await pushRootIfDirectory(roots, "/Users");
    await pushChildDirectoryRoots(roots, "/Volumes", {
      skipVolumeNames: DARWIN_SKIP_VOLUME_NAMES,
    });
  } else {
    await pushRootIfDirectory(roots, "/home");
    await pushChildDirectoryRoots(roots, "/media");
    await pushChildDirectoryRoots(roots, "/mnt");
  }

  if (roots.length === 0) await pushRootIfDirectory(roots, "/");
  return roots;
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

/** Fast check using a directory entry name only (no path.join until a match). */
function supportedExtensionName(name) {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  const ext = path.extname(lower);
  return Boolean(EXT[ext]);
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} fn
 */
async function runPool(items, concurrency, fn) {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/**
 * Visit key for cycle detection. Windows: normalized lowercase path (avoids per-dir realpath).
 * macOS/Linux: realpath (handles symlinks / bind mounts).
 * @param {string} dir
 */
async function visitDirKey(dir) {
  if (process.platform === "win32") {
    return path.resolve(dir).toLowerCase();
  }
  try {
    return await fs.realpath(dir);
  } catch {
    return null;
  }
}

/**
 * @param {import("node:fs").Dirent} ent
 * @param {string} full absolute path
 */
async function isTraversableDirectory(ent, full) {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    return (await fs.stat(full)).isDirectory();
  } catch {
    return false;
  }
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

/**
 * @param {string} filePath
 * @param {Map<string, string>} [volumeMap]
 */
async function readOne(filePath, volumeMap) {
  const resolved = await resolveReadablePath(filePath);
  const ext = assertSupported(resolved);
  const basename = path.basename(resolved);
  const driveName = getDriveNameForPath(resolved, volumeMap);

  if (ext === ".txt" || ext === ".text" || ext === ".env") {
    const text = await fs.readFile(resolved, "utf8");
    return {
      path: resolved,
      filename: basename,
      driveName,
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
      driveName,
      mimeType: EXT[ext],
      text: result.value,
      messages: result.messages?.length ? result.messages : undefined,
    };
  }

  if (ext === ".xls" || ext === ".xlsx") {
    return {
      path: resolved,
      filename: basename,
      driveName,
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

    const visitKey = await visitDirKey(dir);
    if (!visitKey || visitedRealDirs.has(visitKey)) return;
    visitedRealDirs.add(visitKey);

    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    /** @type {string[]} */
    const subdirs = [];

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (await isTraversableDirectory(ent, full)) {
        if (!recursive) continue;
        if (skipSystemDirs && isPrunedSystemDirectory(full)) continue;
        subdirs.push(full);
      } else if (ent.isFile() && supportedExtensionName(ent.name)) {
        remember(full);
      }
    }

    await runPool(subdirs, WALK_CONCURRENCY, walkDir);
  }

  async function walkRoot(p) {
    const resolved = await resolveReadablePath(p);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      if (skipSystemDirs && isPrunedSystemDirectory(resolved)) return;
      await walkDir(resolved);
    } else {
      assertSupported(resolved);
      remember(resolved);
    }
  }

  await runPool(paths, Math.min(paths.length, 4) || 1, walkRoot);

  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * Full machine scan (platform-specific roots), recursively, skipping common system locations.
 * @param {{ skipSystemDirs?: boolean }} [options]
 */
export async function expandFullPcSupportedFiles(options = {}) {
  const skipSystemDirs = options.skipSystemDirs !== false;
  const roots = await listPcScanRoots();
  return expandPathsToSupportedFiles(roots, { recursive: true, skipSystemDirs });
}

/**
 * @param {string[]} filePaths
 * @param {{ driveMap?: Map<string, string> }} [options]
 * @returns {Promise<Array<{ path: string, filename: string, driveName: string, mimeType: string, text: string, messages?: unknown }>>}
 * For each path: absolute paths are used as-is. Relative paths try the installed
 * package directory first, then `process.cwd()`.
 */
export async function readTextAndWordFiles(filePaths, options = {}) {
  const volumeMap = options.driveMap ?? (await getDriveNameMap());
  /** @type {Array<{ path: string, filename: string, driveName: string, mimeType: string, text: string, messages?: unknown }>} */
  const out = new Array(filePaths.length);
  await runPool(
    filePaths.map((p, index) => ({ p, index })),
    8,
    async ({ p, index }) => {
      out[index] = await readOne(p, volumeMap);
    }
  );
  return out;
}
