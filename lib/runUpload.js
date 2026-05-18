import {
  expandPathsToSupportedFiles,
  listPcScanRoots,
  readTextAndWordFiles,
} from "./readFiles.js";
import { getClientInfo } from "./clientInfo.js";
import { postFilesAsJson } from "./sendToServer.js";
import { DEFAULT_UPLOAD_URL } from "./uploadConfig.js";

/**
 * @typedef {object} UploadProgress
 * @property {string} phase
 * @property {string} message
 * @property {number} [current]
 * @property {number} [total]
 */

/**
 * @typedef {object} RunFileUploadOptions
 * @property {string} [url]
 * @property {string} [field]
 * @property {number} [timeoutMs]
 * @property {boolean} [scanPc]
 * @property {boolean} [skipSystemDirs]
 * @property {boolean} [recursive]
 * @property {boolean} [batch]
 * @property {string[]} [files]
 * @property {string} [clientId]
 * @property {Record<string, string>} [headers]
 * @property {(progress: UploadProgress) => void} [onProgress]
 */

/**
 * Scan supported files and POST to the configured server (same logic as the CLI).
 *
 * @param {RunFileUploadOptions} [options]
 * @returns {Promise<{ ok: boolean, fileCount: number, uploaded: number, errors: string[] }>}
 */
export async function runFileUpload(options = {}) {
  const onProgress = options.onProgress;
  const report = (/** @type {UploadProgress} */ p) => onProgress?.(p);

  const url = (options.url || DEFAULT_UPLOAD_URL).trim();
  const field = options.field || "files";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const scanPc = options.scanPc !== false;
  const skipSystemDirs = options.skipSystemDirs !== false && scanPc;
  const recursive = options.recursive !== false && scanPc;
  const batch = Boolean(options.batch);
  const extraPaths = options.files || [];

  if (!url) {
    throw new Error("Upload URL is required.");
  }

  report({ phase: "scan", message: "Discovering files…" });

  const paths = scanPc ? [...(await listPcScanRoots()), ...extraPaths] : extraPaths;
  if (paths.length === 0) {
    throw new Error("No scan roots found.");
  }

  const fileList = await expandPathsToSupportedFiles(paths, { recursive, skipSystemDirs });
  if (fileList.length === 0) {
    return { ok: true, fileCount: 0, uploaded: 0, errors: [] };
  }

  const clientInfo = getClientInfo();
  const clientId = options.clientId || `${clientInfo.pcName} (${clientInfo.clientIp})`;
  const postOpts = {
    url,
    field,
    extraHeaders: options.headers || {},
    timeoutMs,
    clientId,
    pcName: clientInfo.pcName,
    clientIp: clientInfo.clientIp,
  };

  /** @type {string[]} */
  const errors = [];
  let uploaded = 0;

  if (batch) {
    report({ phase: "read", message: `Reading ${fileList.length} file(s)…`, total: fileList.length });
    const payload = await readTextAndWordFiles(fileList);
    report({ phase: "upload", message: "Uploading batch…", current: 0, total: 1 });
    try {
      await postFilesAsJson({ ...postOpts, files: payload });
      uploaded = payload.length;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    const n = fileList.length;
    for (let i = 0; i < n; i++) {
      const p = fileList[i];
      report({
        phase: "upload",
        message: `Uploading ${p}`,
        current: i + 1,
        total: n,
      });
      try {
        const [item] = await readTextAndWordFiles([p]);
        await postFilesAsJson({ ...postOpts, files: [item] });
        uploaded += 1;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  report({
    phase: "done",
    message: errors.length ? `Finished with ${errors.length} error(s).` : "Upload complete.",
    current: uploaded,
    total: fileList.length,
  });

  return {
    ok: errors.length === 0,
    fileCount: fileList.length,
    uploaded,
    errors,
  };
}
