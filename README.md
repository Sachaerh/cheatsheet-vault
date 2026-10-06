# Cheatsheet Vault

A self-hosted, searchable library for cheat sheets in Markdown, HTML, PDF and plain text.
It has no database: every sheet is a plain file in one folder (`SHEETS_DIR`), and the app's folders are real subfolders (`code/python`).

## Features

- Library: card grid, full-text search across every sheet (including PDF text) with highlighted snippets,
  starred sheets, sort by recent or A–Z, light/dark mode and a phone layout. Press `/` to search.
- Folders:
  - A sidebar tree with expand/collapse and sheet counts. Opening a folder shows a breadcrumb, its subfolders as tiles, and its own sheets.
  - Create empty folders. An empty folder holds a hidden `.keep` file so it isn't removed.
  - Rename, move or delete a folder from its ⋯ button or a right-click. A deleted folder goes to `.trash` with everything in it.
  - Move sheets by dragging a card onto a folder (sidebar, tile or breadcrumb), or tick several cards and use **Move to…**.
  - New, pasted and uploaded sheets go into the folder you're in.
  - Search always covers every folder.
- Stars are kept in `SHEETS_DIR/.stars.json`, so every device shares them and they follow a sheet when it or its folder moves.
  Stars kept in the browser by version 1.0 are merged in on first load.
- Viewer:
  - Markdown is rendered on the server with syntax-highlighted code, Copy buttons, a table of contents and a print layout.
    The Copy buttons fall back to `execCommand('copy')` over plain HTTP.
  - HTML sheets run in a sandboxed iframe (`allow-scripts`, no same-origin) and are served with
    `Content-Security-Policy: sandbox allow-scripts`.
  - PDFs are embedded.
- Adding sheets: paste content (Markdown or HTML is detected automatically), upload several files, or drag files onto the page.
- Create from link (optional, off unless a Claude API key is configured): paste a web page link, pick a folder and optionally a focus
  ("just the keyboard shortcuts"). The server fetches the page, Claude writes a condensed cheat sheet in its own words,
  and it is saved as Markdown with the source link at the bottom. The dialog shows each step and can be cancelled.
  See [Create from link](#create-from-link) for the limits and safety checks.
- Offline library (optional, off unless `KIWIX_URL` is set): an **Offline library** link in the sidebar opens a
  [Kiwix](https://kiwix.org) server, and searches also list matching Kiwix articles in their own section below your sheets.
  See [Offline library](#offline-library).
- Managing sheets: edit, rename, move to another folder, or delete. Deleted sheets go to `SHEETS_DIR/.trash/`.
- Security:
  - Optional HTTP basic auth.
  - Every path is checked so it can't leave `SHEETS_DIR`, and symlinks are not followed.
    Folder paths are refused outright (not repaired) if any part is `.`, `..`, hidden (starts with a dot), or contains `\`, control characters or `: * ? " < > |`.
  - API calls need an `X-Vault: 1` header and a same-host origin, so scripts in HTML sheets can't use the API.
  - Markdown output is sanitized on the server for every sheet: no scripts, event handlers, `javascript:` or protocol-relative links,
    inline styles, iframes, SVG, forms or embeds, and only syntax-highlighting classes. The page CSP (`script-src 'self'`) is a second layer.
- A "Getting Started" sheet is created only when the data folder is empty.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `SHEETS_DIR` | `./data` | Folder holding the sheets |
| `AUTH_USER`, `AUTH_PASS` | unset | Turn on basic auth when both are set |
| `MAX_UPLOAD_MB` | `25` | Per-file upload and paste limit |
| `ANTHROPIC_API_KEY` | unset | Turns on **Create from link**. Keep it in the root-only secrets env file; it is never sent to the browser or logged |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for Create from link |
| `KIWIX_URL` | unset | Turns on the **Offline library**: how the vault server reaches kiwix-serve, e.g. `http://192.168.1.10:30236` |
| `KIWIX_HTTPS_PORT` | unset | Port of an HTTPS front for Kiwix (e.g. `tailscale serve`), used for the sidebar link when the vault is opened over HTTPS |

## Create from link

This feature is **optional** and **off by default**. Without an API key the **From link** button is hidden,
`POST /api/from-link` answers 503, and everything else works as usual. Nothing is sent to Claude.

To turn it on:

1. Create an API key in the Claude Console (platform.claude.com → API Keys). Usage is billed per token to that Console
   account's credits. A Claude Pro/Max subscription does not cover it. A dedicated key in a workspace with a spend limit is a good idea.
2. Add it to the environment as `ANTHROPIC_API_KEY`. On TrueNAS, add `ANTHROPIC_API_KEY=sk-ant-...` to
   `/mnt/POOL/apps/secrets/cheatsheet-vault.env` (root only, mode 600).
3. Restart the app: `sudo midclt call -j app.stop cheatsheet-vault && sudo midclt call -j app.start cheatsheet-vault`.
   The **From link** button appears next to **New sheet**.
4. Optionally set `CLAUDE_MODEL` to use a different model (default `claude-opus-5-5`).

To turn it off again, remove the line and restart.

How it works and what is checked:

- Only public `http`/`https` links on ports 80 and 443, without a user name or password.
- The address is checked after DNS resolution and again on every redirect (at most 5). If any address a name resolves to is
  loopback, private (10/8, 172.16/12, 192.168/16), CGNAT/Tailscale (100.64/10, fd7a:115c:a1e0::/48), link-local, multicast
  or another special range (IPv4-mapped, NAT64 and 6to4 IPv6 forms included), the request is refused. The connection is made to the
  address that was checked, so DNS rebinding can't swap it. Names ending in `.local`, `.localhost`, `.internal` or `.ts.net` and
  single-label names are refused outright.
- Limits: 15 seconds, 3 MB (counted after decompression), HTML or plain text only, and at most 200,000 characters of text.
  Longer pages are refused rather than cut, so add a focus or use a more specific page.
- The page goes to Claude as untrusted data. The instructions tell it to summarize only, in its own words, without copying passages,
  and to ignore any instructions inside the page. The source line is added by the server, not by the model.
- One link is processed at a time. Each sheet is one Claude API call, billed to your API account.

## Offline library

This feature is **optional** and **off by default**. It links the vault to a [kiwix-serve](https://github.com/kiwix/kiwix-tools)
instance holding ZIM files (Wikipedia-style offline copies of sites, from [library.kiwix.org](https://library.kiwix.org)).

- Set `KIWIX_URL` to the address the vault *server* uses to reach kiwix-serve. On TrueNAS, install the catalog app
  **Kiwix Server** with its data storage pointing at a dataset of `.zim` files, and use `http://<NAS LAN IP>:<its port>`.
- The sidebar gets an **Offline library ↗** link. It points at the host the browser used for the vault, on `KIWIX_URL`'s port.
  If the vault is opened over HTTPS and `KIWIX_HTTPS_PORT` is set, it uses `https://` on that port instead
  (for example `tailscale serve --bg --https=8444 http://127.0.0.1:30236`).
- Searching shows your sheets first. Kiwix articles load separately in an **Offline library** section below them,
  through `GET /api/library-search?q=` on the vault server (kiwix-serve `/search?format=xml`, all books, top 10, with a link to the full results in Kiwix).
  No result count is shown, because kiwix-serve's total is unreliable when several books are searched.
  The browser never talks to Kiwix for search. If Kiwix is stopped, slow (3 second limit) or answers with something
  unexpected, that section says the library isn't responding, and sheet search works as usual.
- Results are plain text (titles, book name and a snippet); links must be paths on the Kiwix server.
- Translated copies of English articles are left out of vault search so they don't crowd out the English ones.
  They are still in Kiwix itself:
  - WikEM's machine translations (`<Page>/de`, `/fr`, … in 15 languages). `<Page>/en` copies are English and are kept.
  - ArchWiki translations (`<Page> (<Language>)` and pages under them, about 6,600 pages; 55 language names, listed
    in `lib/kiwix.js`). English pages that end in parentheses, such as `(Gen 2)` or `(AMD)`, are kept.
- Only ZIMs with a full-text index are searchable. Collections that wrap PDFs (such as the zimgit ones) can be read in Kiwix
  but are mostly not found by search.
- kiwix-serve loads its ZIM files at start, so restart the Kiwix app after adding or replacing one.

## Run locally

```bash
npm install
npm test
SHEETS_DIR=./data AUTH_USER=me AUTH_PASS=secret npm start
```

Or with Docker: `docker build -t cheatsheet-vault . && docker run -p 3000:3000 -v $PWD/data:/data cheatsheet-vault`.

## Deploying on TrueNAS SCALE 25.10+

Replace `POOL` with your pool name throughout (in `compose.truenas.yaml` too).

| What | Where |
|---|---|
| Dataset | `POOL/apps/cheatsheet-vault`, with a daily 03:00 snapshot kept for 14 days |
| Code | `/mnt/POOL/apps/cheatsheet-vault/app`, mounted read-only at `/app` |
| Sheets | `/mnt/POOL/apps/cheatsheet-vault/data`, mounted at `/data`, owned by `apps` (568) |
| Login | `/mnt/POOL/apps/secrets/cheatsheet-vault.env` (root only, mode 600) |
| App | TrueNAS custom app `cheatsheet-vault`, image `node:22-alpine`, port 30090. The compose file is `compose.truenas.yaml`. |

### Updating the app (your sheets are never touched)

The sheets live in `data/`, outside the code folder. An update only replaces `app/`:

```bash
cd /mnt/POOL/apps/cheatsheet-vault
sudo zfs snapshot POOL/apps/cheatsheet-vault@before-update-$(date +%F)
# copy the new code over app/ (keep node_modules out of the copy), then:
cd app
sudo docker run --rm --user 568:568 -e npm_config_cache=/tmp/.npm -v "$PWD":/app -w /app node:22-alpine \
  sh -c 'npm ci --omit=dev && npm test'
sudo chown -R 568:568 .
sudo midclt call -j app.stop cheatsheet-vault && sudo midclt call -j app.start cheatsheet-vault
```

To get a newer Node 22 image, use **Apps → cheatsheet-vault → Update image** (or `midclt call -j app.pull_images cheatsheet-vault`).
To change the password, edit the `.env` file, then stop and start the app.

### Restoring a sheet

- Deleted from the UI: it's in `data/.trash/` with a timestamp prefix (folder paths are flattened with `__`, e.g. `…__code__python`). Move it back into `data/`.
- Older version: copy it out of `/mnt/POOL/apps/cheatsheet-vault/.zfs/snapshot/<snapshot>/data/`.

## License

License: MIT. See [LICENSE](LICENSE).
