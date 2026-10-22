# Chatter — agent guide

Kept short on purpose: it loads into every session. The detail lives in `docs/design/` — open the one file for the area you are changing (table below), not all of them.

## What this is

A self-hosted, Discord-like chat app: a Rust (Axum) server backed by **MongoDB**, serving a React + Vite web client. Two more apps use the same server: an Android app (`mobile/`, React Native/Expo) and a desktop app (Electron, separate repo `Chatter-Desktop`, which loads this web client from the server).

## Layout

| Path | What |
|---|---|
| `src/main.rs`, `src/backend/` | Server. `app.rs` startup and background tasks, `router.rs`, `routes/` one file per area, `ws/` WebSocket session and voice/screen/webcam signalling, `webrtc.rs` the SFU, `helpers.rs` permissions and shared checks, `push.rs`/`webpush.rs` Web Push |
| `tests/` | Integration tests; they start a real server against MongoDB |
| `packages/core/` | Shared client logic, no React and no DOM: `api.ts`, `store/` (types, reducer, actions, wsHandler), `voice/` (call engine, stream viewer/publisher), notification and unread rules. Imported as `@chatter/core/*` by the web client and the mobile app |
| `client/` | Web client (React, shadcn/ui). Browser glue for core is `src/lib/host.ts` |
| `mobile/` | Android app. Has its own `AGENTS.md`, loaded when you work there |
| `docs/design/` | Design notes by area |
| `scripts/` | `rust-ci.sh` (the Rust gate), `rust-security.sh` |

## Commands

```bash
cargo run                                   # server + built client at http://localhost:8000 (needs MongoDB; MONGODB_URI, default mongodb://localhost:27017)
cd client && npm install && npm run dev     # web dev server at :5173, proxies the API to :8000
cd client && npm run build                  # needed before `cargo run` serves the client
cd packages/core && npm run check           # core: typecheck, lint, tests
docker build -t chatter . && docker run -p 8000:8000 chatter
```

## Before you push — CI runs these on every push to `main` and every PR

- **Rust:** `./scripts/rust-ci.sh` — `cargo check`, `cargo fmt --check`, clippy with `-D warnings`, all tests (needs MongoDB and ffmpeg). Run `cargo fmt` first; a formatting diff fails the gate. Each integration test makes its own `chatter_test_*` database and drops it, but point `MONGODB_URI` at a scratch MongoDB anyway, never one with real data.
- **Rust dependencies:** `./scripts/rust-security.sh` (cargo-deny and cargo-audit). Update crates with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update` — the toolchain is pinned to Rust 1.88 and a plain update can pull in crates that need a newer one.
- **Anything in `packages/core`, `client` or `mobile`:** `.github/workflows/clients.yml` checks all three — core `npm run check`, web `npm run build` (what the Docker image runs), mobile `npm run typecheck && npm run lint`. **A change to core must keep both apps compiling**: run the mobile typecheck too, even if you never opened `mobile/`.
- A push to `main` does **not** deploy. Deploying is manual (Actions → Deploy Noodle Bot, or the server's own script).

## Rules

- One feature at a time, validated working before the next. Simple, MVP-style functionality; make the core features work well.
- Shared logic goes in `packages/core`, not `client/`: API calls, store actions, socket handling, protocol rules — anything both apps need. Anything touching `window`/`document` stays in the client or goes through `host` (eslint enforces it).
- Installed apps lag behind the server (desktop apps, Android APKs installed by hand). Keep server changes **backward compatible**: add fields and messages, don't rename or remove them. Each client names itself on its first socket frame (`client: {kind, version}`).
- The desktop app type-checks against `client/src/lib/desktop/bridge.ts` and `client/src/lib/media/types.ts`: change those additively only. See `docs/design/desktop.md`.
- Some rules exist twice, once on the server and once in core, and must change together — notification levels (`push.rs` ↔ `notifications.ts`), what counts as a mention (`read_markers.rs` ↔ `wsHandler.ts`), the sound events, the name-font URL check. The design notes say which.
- Never point tests or scripts at a database or server other people use.

## Design notes — read the one you need

| Changing… | Read |
|---|---|
| Messages, paging, links, pins, threads, deletes, socket recovery, API patterns | `docs/design/messages.md` |
| Notifications, push, unread counts, mentions, read markers | `docs/design/notifications-unreads.md` |
| Forums, polls, GIF favourites | `docs/design/forum-polls-gifs.md` |
| Roles, channel overwrites, permission checks, rate limits, audit log, blocking, timeouts, rules, reports, automod, admin | `docs/design/permissions-moderation.md` |
| Uploads, video conversion, thumbnails, purging files | `docs/design/uploads-media.md` |
| Voice, screen share, webcams, spatial channels, the SFU | `docs/design/voice.md` |
| Themes, profile themes, presence/idle, sidebar and rail, sounds, drafts, the composer | `docs/design/client-ui.md` |
| The desktop app's bridge and voice media backends | `docs/design/desktop.md` |
| WebRTC architecture overview | `docs/webrtc-architecture.md` |

When you change behaviour a note describes, update the note in the same commit.

## Working efficiently

- These files are 1,300–5,000 lines; search for the symbol and read around it rather than reading them whole: `routes/media.rs`, `ws/session.rs`, `routes/messages.rs`, `routes/rooms.rs`, `helpers.rs`, `routes/forum.rs`, `state.rs`, `ChatArea.tsx`, `UserProfileDialog.tsx`, `MessageItem.tsx`, `RoomDialogs.tsx`, `AppSidebar.tsx`, `ChannelList.tsx`, `packages/core/src/store/actions.ts`.
- Old `client/src/lib/*` paths for API and store code are one-line re-exports of `packages/core`; edit the core file.
