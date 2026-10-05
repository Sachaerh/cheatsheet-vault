# Cheatsheet Vault

A self-hosted, searchable library for cheat sheets in Markdown, HTML, PDF and plain text.
It has no database: every sheet is a plain file in one folder (`SHEETS_DIR`), and subfolders are categories (`code/python`).

## Features

- Library: card grid, full-text search across every sheet (including PDF text) with highlighted snippets,
  a category sidebar with counts, starred sheets (kept in the browser), sort by recent or A–Z,
  light/dark mode and a phone layout. Press `/` to search.
- Viewer:
  - Markdown is rendered on the server with syntax-highlighted code, Copy buttons, a table of contents and a print layout.
    The Copy buttons fall back to `execCommand('copy')` over plain HTTP.
  - HTML sheets run in a sandboxed iframe (`allow-scripts`, no same-origin) and are served with
    `Content-Security-Policy: sandbox allow-scripts`.
  - PDFs are embedded.
- Adding sheets: paste content (Markdown or HTML is detected automatically), upload several files, or drag files onto the page.
- Managing sheets: edit, rename, move to another category, or delete. Deleted sheets go to `SHEETS_DIR/.trash/`.
- Security:
  - Optional HTTP basic auth.
  - Every path is checked so it can't leave `SHEETS_DIR`, and symlinks are not followed.
  - API calls need an `X-Vault: 1` header and a same-host origin, so scripts in HTML sheets can't use the API.
  - Markdown output is sanitized.
- A "Getting Started" sheet is created only when the data folder is empty.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `SHEETS_DIR` | `./data` | Folder holding the sheets |
| `AUTH_USER`, `AUTH_PASS` | unset | Turn on basic auth when both are set |
| `MAX_UPLOAD_MB` | `25` | Per-file upload and paste limit |

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

- Deleted from the UI: it's in `data/.trash/` with a timestamp prefix. Move it back into `data/`.
- Older version: copy it out of `/mnt/POOL/apps/cheatsheet-vault/.zfs/snapshot/<snapshot>/data/`.
