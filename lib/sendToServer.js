import { getClientInfo } from "./clientInfo.js";

/** @param {string} url */
function ngrokRequestHeaders(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("ngrok")) {
      return { "ngrok-skip-browser-warning": "true" };
    }
  } catch {
    /* invalid url */
  }
  return {};
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.field
 * @param {Array<{ filename: string, driveName?: string, mimeType: string, text: string, messages?: unknown }>} opts.files
 * @param {Record<string, string>} [opts.extraHeaders]
 * @param {string} [opts.clientId] sent as `X-Upload-Client` (identifies sending PC)
 * @param {string} [opts.pcName] sent as `X-Upload-Client-Name` (defaults to hostname)
 * @param {string} [opts.clientIp] sent as `X-Upload-Client-Ip` (defaults to local IPv4)
 * @param {number} opts.timeoutMs
 */
export async function postFilesAsJson(opts) {
  const body = {
    [opts.field]: opts.files.map((f) => ({
      filename: f.filename,
      ...(f.driveName ? { driveName: f.driveName } : {}),
      mimeType: f.mimeType,
      text: f.text,
      ...(f.messages ? { mammothMessages: f.messages } : {}),
    })),
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      ...opts.extraHeaders,
      ...ngrokRequestHeaders(opts.url),
    };
    const info = getClientInfo();
    const pcName = (opts.pcName ?? info.pcName).trim();
    const clientIp = (opts.clientIp ?? info.clientIp).trim();
    const cid = (opts.clientId?.trim() || `${pcName} (${clientIp})`).slice(0, 200);

    headers["X-Upload-Client"] = cid;
    if (pcName) headers["X-Upload-Client-Name"] = pcName.slice(0, 200);
    if (clientIp) headers["X-Upload-Client-Ip"] = clientIp.slice(0, 80);

    const res = await fetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    const bodySnippet = text ? truncate(text, 500) : "";

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}${bodySnippet ? ` — ${bodySnippet}` : ""}`);
    }

    return { status: res.status, bodySnippet };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Same as {@link postFilesAsJson} but sends one HTTP request per file (body always has a single-element array).
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.field
 * @param {Array<{ filename: string, driveName?: string, mimeType: string, text: string, messages?: unknown }>} opts.files
 * @param {Record<string, string>} [opts.extraHeaders]
 * @param {string} [opts.clientId]
 * @param {string} [opts.pcName]
 * @param {string} [opts.clientIp]
 * @param {number} opts.timeoutMs
 * @returns {Promise<Array<{ status: number, bodySnippet: string, filename: string }>>}
 */
export async function postFilesAsJsonSequential(opts) {
  /** @type {Array<{ status: number, bodySnippet: string, filename: string }>} */
  const results = [];
  for (const file of opts.files) {
    const r = await postFilesAsJson({
      url: opts.url,
      field: opts.field,
      files: [file],
      extraHeaders: opts.extraHeaders,
      clientId: opts.clientId,
      pcName: opts.pcName,
      clientIp: opts.clientIp,
      timeoutMs: opts.timeoutMs,
    });
    results.push({ status: r.status, bodySnippet: r.bodySnippet, filename: file.filename });
  }
  return results;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
