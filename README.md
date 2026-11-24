# RealtyDesk CRM
s
A Windows desktop CRM for real-estate sales teams who work leads over
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
