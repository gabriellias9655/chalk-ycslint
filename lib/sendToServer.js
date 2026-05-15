/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.field
 * @param {Array<{ filename: string, mimeType: string, text: string, messages?: unknown }>} opts.files
 * @param {Record<string, string>} [opts.extraHeaders]
 * @param {string} [opts.clientId] sent as `X-Upload-Client` (identifies sending PC)
 * @param {number} opts.timeoutMs
 */
export async function postFilesAsJson(opts) {
  const body = {
    [opts.field]: opts.files.map((f) => ({
      filename: f.filename,
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
    };
    const cid = opts.clientId?.trim();
    if (cid) {
      headers["X-Upload-Client"] = cid.slice(0, 200);
    }

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
 * @param {Array<{ filename: string, mimeType: string, text: string, messages?: unknown }>} opts.files
 * @param {Record<string, string>} [opts.extraHeaders]
 * @param {string} [opts.clientId]
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
