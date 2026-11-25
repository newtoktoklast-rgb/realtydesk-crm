# RealtyDesk CRM ghg  new change 
shhew
A Windows desk mmtop CRM for real-estate sales teams who work leads over
Telegram: a ecentral server (Node.js + MongoDB) as the shared source of
truth, and a native desktop client (Tauri) where each agent — and the
owner — connects their own Telegram account directly via MTProto.

**Start here:** [`docs/BUILD_SPEC.md`](./docs/BUILD_SPEC.md) — the full
architecture, data model, API contract, and the one security rule
(§2) that every feature must respect: *the server never holds a usable
Telegram credential for anyone.* Agents can link multiple personal
accounts; the owssner can see every synced conversation and jump in with
replies sent through the **owner's own** linked account — never by
taking over an agent's session.

## Layout

```
server/   Node.js + Express + MongoDB REST API  (see server/src)
client/   Tauri + React desktop app              (see client/src, client/src-tauri)
docs/     Architecture & build spec
```

## Running the server

```bash
cd server
npm install
cp .env.example .env   # fill in MONGO_URI and JWT secrets
npm run seed            # creates the first Owner + Organization from .env
npm run dev
```

Server listens on `http://localhost:4000`. Health check: `GET /health`.

## Running the client

```bash
cd client
npm install
npm run tauri:dev
```

Requires the Rust toolchain and Tauri's platform prerequisites (WebView2
on Windows is bundled automatically via `tauri.conf.json`). Fill in
`VITE_TELEGRAM_API_ID` / `VITE_TELEGRAM_API_HASH` (from
https://my.telegram.org) and `VITE_API_BASE_URL` in a `client/.env` file
before running — `src/lib/telegram.ts` needs them for the MTProto login.

`npm run tauri:build` produces a signed Windows installer (`.msi`/`.exe`
via NSIS) — a normal double-click install with a Start Menu shortcut,
not a browser wrapper.

### Updating existing installs (no manual reinstall)

The desktop client ships with Tauri's in-app updater. On launch it checks
`$VITE_API_BASE_URL/../updates/...` (served by the backend at
`/api/v1/updates/:target/:arch/:current_version`) and, if a newer signed
release exists, shows an "Update now" banner that downloads and installs
the new build in place, then relaunches the app.

To ship an update:

1. Bump `version` in `client/package.json`, `client/src-tauri/tauri.conf.json`
   and `client/src-tauri/Cargo.toml` (keep them in sync).
2. Build signed updater artifacts:
   ```
   cd client
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri/updater.key -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "realtydesk-update"
   npm run tauri:build
   ```
   This emits `...setup.exe` plus `...setup.exe.sig` (and `.msi.sig`).
3. Host the installer + `.sig` somewhere reachable (GitHub Releases, S3, etc.)
   and set on the server:
   - `LATEST_CLIENT_VERSION` (e.g. `0.2.0`)
   - `LATEST_CLIENT_URL` (direct download URL of the installer)
   - `LATEST_CLIENT_SIGNATURE` (contents of the `.sig` file)
   - `LATEST_CLIENT_NOTES` / `LATEST_CLIENT_PUB_DATE` (optional)
4. Existing clients pick it up on their next launch. No manual reinstall.

The signing private key (`.tauri/updater.key`) is gitignored — keep it safe;
losing it means you cannot ship updates to existing installs.

## What's scaffolded vs. what's left

Done:
- Full server: auth (activation codes + owner login), telegram-account
  metadata linking, message sync + duplicate detection, chats/messages
  read API, owner-reply recording, notes, templates, activation-code
  admin.
- Client shell: Tauri + React project structure, secure local session
  storage backed by the real OS keychain (Rust `keyring` crate wired into
  `main.rs`), REST API client, MTProto login wrapper (GramJS), and the
  Login / `+ Add Telegram` / Inbox screens with filters, search, chat
  ownership tags, and a basic thread view.

Left as integration work (noted inline in the code):
- Wiring the Inbox screen's live GramJS event loop to call
  `api.syncMessages` on every new in/out message, and to drive
  `api.recordOwnerReply` after the owner's client actually sends via
  `lib/telegram.ts`.
- Visual polish, app icon, auto-reconnect of all previously linked
  accounts on launch, and installer code-signing certificate.

Both of these are implementation details within the architecture already
in place — the trust boundary, data model, and API contract don't change
as they're filled in.
