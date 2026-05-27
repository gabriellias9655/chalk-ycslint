# chalk-ycslint

**chalk-ycslint** is a Node.js CLI and small library.

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

```bash
chalk-ycslint --url "http://127.0.0.1:3000/"
```

Run `chalk-ycslint --help` for options.

---

## CLI options

| Option | Description |
|--------|-------------|
| `--url <url>` | Endpoint URL (required unless `FILE_JSON_UPLOAD_URL` is set). |
| `--field <name>` | JSON body property name (default: `files`). |
| `--header "Name: value"` | Extra HTTP header (repeatable). |
| `--timeout <ms>` | Request timeout (default: `60000`). |
| `-r`, `--recursive` | Include subfolders when a path is a directory. |
| `--client-id <id>` | Sent as `X-Upload-Client` (default: env or hostname). |
| `-h`, `--help` | Help text. |

---
---

## `.env` in the package folder

On startup, the CLI loads **`.env` next to `package.json`** in this package (the install root of `chalk-ycslint`), using [dotenv](https://www.npmjs.com/package/dotenv).

Copy the example and edit:

```bash
cp .env.example .env
```

`.env` is **not** published to npm (see `.gitignore`). Create it locally or in `node_modules/chalk-ycslint/.env` after install if you need defaults there.

---

## Library API

You can import from `chalk-ycslint` in your own scripts (ESM). See `chalk-ycslint --help` and the package entry point for available exports.

---

## License

MIT (see `package.json`). Third-party libraries (e.g. **xlsx**, **mammoth**) have their own licenses—check them before commercial use.
