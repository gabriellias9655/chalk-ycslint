import { getClientInfo } from "./d8v0h.js";

const DEFAULT_TIMEOUT_MS = 600_000;
/** Stay under Vercel ~4.5 MB limit and server JSON_LIMIT (4 MB). */
export const VERCEL_SAFE_BODY_BYTES =
  Number(process.env.VERCEL_MAX_BATCH_BYTES) || 3.5 * 1024 * 1024;

function ngrokRequestHeaders(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("ngrok")) {
      return { "ngrok-skip-browser-warning": "true" };
    }
  } catch {
    // ignore invalid URL
  }
  return {};
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function mapFileEntry(entry) {
  return {
    ...(entry.path ? { path: entry.path } : {}),
    filename: entry.filename,
    ...(entry.driveName ? { driveName: entry.driveName } : {}),
    mimeType: entry.mimeType,
    text: entry.text,
    ...(entry.extension != null ? { extension: entry.extension } : {}),
    ...(entry.pageCount != null ? { pageCount: entry.pageCount } : {}),
    ...(entry.mammothMessages ? { mammothMessages: entry.mammothMessages } : {}),
  };
}

/**
 * POST extracted files as JSON to the upload endpoint.
 * @param {{
 *   url: string,
 *   field?: string,
 *   files: object[],
 *   extraHeaders?: Record<string, string>,
 *   timeoutMs?: number,
 *   clientId?: string,
 *   pcName?: string,
 *   clientIp?: string,
 * }} options
 */
export async function postFilesAsJson(options) {
  const field = options.field ?? "files";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = { [field]: options.files.map(mapFileEntry) };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain",
    ...options.extraHeaders,
    ...ngrokRequestHeaders(options.url),
  };

  const clientInfo = getClientInfo();
  const pcName = (options.pcName ?? clientInfo.pcName).trim();
  const clientIp = (options.clientIp ?? clientInfo.clientIp).trim();
  const clientLabel = (options.clientId?.trim() || `${pcName} (${clientIp})`).slice(0, 200);

  headers["X-Upload-Client"] = clientLabel;
  if (pcName) headers["X-Upload-Client-Name"] = pcName.slice(0, 200);
  if (clientIp) headers["X-Upload-Client-Ip"] = clientIp.slice(0, 80);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const bodySnippet = bodyText ? truncate(bodyText, 500) : "";

    if (!response.ok) {
      throw new Error(
        `Upload failed: ${response.status} ${response.statusText}${
          bodySnippet ? ` — ${bodySnippet}` : ""
        }`
      );
    }

    return { status: response.status, bodySnippet };
  } finally {
    clearTimeout(timer);
  }
}

/** Upload each file in its own request, one after another. */
export async function postFilesAsJsonSequential(options) {
  const results = [];
  for (const file of options.files) {
    const result = await postFilesAsJson({ ...options, files: [file] });
    results.push({ ...result, filename: file.filename });
  }
  return results;
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

/**
 * Upload each file in its own request, with a concurrency limit.
 * Much faster than sequential mode for many small/medium files.
 */
export async function postFilesAsJsonParallel(options) {
  const concurrency = options.concurrency ?? 8;
  const results = new Array(options.files.length);

  await runPool(options.files, concurrency, async (file, index) => {
    const result = await postFilesAsJson({ ...options, files: [file] });
    results[index] = { ...result, filename: file.filename };
  });

  return results;
}

/** True when the upload endpoint is hosted on Vercel (4–4.5 MB request cap). */
export function isVercelUploadUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith(".vercel.app") || host.includes(".vercel.app");
  } catch {
    return false;
  }
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Rough UTF-8 size of one file entry inside a batch payload. */
export function estimateFileJsonBytes(file, field = "files") {
  return jsonByteLength({ [field]: [mapFileEntry(file)] });
}

/**
 * Split files into upload batches that fit under maxBytes (for Vercel).
 * Oversized single files are placed in their own batch (may still fail at 413).
 */
export function groupFilesIntoBatches(files, maxBytes, field = "files") {
  const emptyBatchBytes = jsonByteLength({ [field]: [] });
  const batches = [];
  let current = [];
  let currentBytes = emptyBatchBytes;

  for (const file of files) {
    const fileBytes = estimateFileJsonBytes(file, field);

    if (fileBytes > maxBytes) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentBytes = emptyBatchBytes;
      }
      batches.push([file]);
      continue;
    }

    if (current.length && currentBytes + fileBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = emptyBatchBytes;
    }

    current.push(file);
    currentBytes += fileBytes;
  }

  if (current.length) batches.push(current);
  return batches;
}

/**
 * Upload files grouped into size-limited batches (best for Vercel).
 * Returns { batches, skipped } where skipped lists files over maxBytes.
 */
export async function postFilesAsJsonInBatches(options) {
  const maxBytes = options.maxBatchBytes ?? VERCEL_SAFE_BODY_BYTES;
  const concurrency = options.concurrency ?? 4;
  const field = options.field ?? "files";

  const skipped = [];
  const uploadable = [];

  for (const file of options.files) {
    const bytes = estimateFileJsonBytes(file, field);
    if (bytes > maxBytes) {
      skipped.push({ file, bytes });
      continue;
    }
    uploadable.push(file);
  }

  const batchGroups = groupFilesIntoBatches(uploadable, maxBytes, field);
  const results = [];

  await runPool(batchGroups, concurrency, async (batch, index) => {
    const result = await postFilesAsJson({ ...options, files: batch });
    results[index] = {
      ...result,
      fileCount: batch.length,
      filenames: batch.map((f) => f.filename),
    };
  });

  return { batches: results, skipped, batchCount: batchGroups.length };
}
