# Multi-server sign-in (design draft)

Status: **proposal, nothing built yet.** Read before starting any of it, or before changing `packages/core/src/api.ts`, the store's shape, or the desktop/mobile server pickers in a way that would make it harder.

Goal: one person signed in to several Chatter servers at once, with every server's rooms in one room list.

## Decision

Build a **multi-account client**: each server stays fully independent and the client holds one session per server, merging them in the UI. Servers never talk to each other.

Not chosen:

- **Federation (Matrix-style)** — your home server talks to the others for you. Needs trust between servers, copying data between them, moderating remote users, media proxying and abuse handling. Months of work and a permanent security burden. The `@name:localhost` user ID format leans this way, but that is not a reason to do it.
- **Server rail only (Discord-style)** — desktop and mobile show a strip of server icons, and each server opens in its own isolated view running that server's client. Almost no refactoring and no tokens shared, but no merged room list. Acceptable as a stopgap that ships first; it does not block the multi-account client.

Rooms are merged into one list but **always labelled by server** (an icon or section header, server colour on mentions). An untrusted server must not be able to pass its `#general` or `admin` off as your trusted server's. "As if from one instance" is a non-goal.

## Where the code is today

Everything assumes one server:

- `packages/core/src/api.ts` — `_origin`, `_accessToken`, `_refreshStore` and `_refreshPromise` are module singletons; every call, upload and refresh uses them.
- The store — one `AppState`, one WebSocket, one `wsHandler` (with module-level timers). Room, user and channel IDs are bare strings.
- User IDs are always `@name:localhost` (`format_user_id`, `helpers.rs`), so the same username on two servers collides. Room IDs are random (`generate_id`) and won't clash by accident, but a malicious server can reuse another's IDs on purpose. **Never trust an ID without its server.**
- Web auth: the refresh token is a `SameSite=Strict` HttpOnly cookie on the origin that served the page. The mobile path (`RefreshTokenStore`, token in the request body, `credentials: "omit"`) already works without cookies; other servers must use it.
- Mobile (`mobile/src/platform/server.ts`) stores one server; changing it signs out. Desktop loads the client from one server and has `changeServer()` in the bridge.

## Security

- **Web host trust.** In a browser, the page from server A would hold B's refresh token in script-readable storage. A bad admin on A, or an XSS bug on A, takes over your account on B. This breaks the current rule that the refresh token is never readable by script. **The web client stays single-server**, unless that changes later and is limited to an admin-approved list of servers.
- **Desktop has the same problem**, because it loads the client from a server. Tokens for every server stay in the Electron main process and requests go through the bridge. Never hand a token to the page.
- **Android** keeps one refresh token per server in the Keystore, keyed by origin.
- **No leaks between servers.** Content, links and tokens from one server must never reach another: link previews, message/channel/forum links, embeds, image URLs carrying `?access_token=`, paste and drag between rooms. Every URL is resolved against the server the content came from.
- Cross-origin access on the server is limited to the token-in-body API and the WebSocket. Never allow credentials for arbitrary origins, and never relax the cookie.

## Behaviour per server

Each server is a separate account. Nothing crosses over in the MVP:

- Profile, avatar, name font, profile theme, status and idle, roles, admin status, two-factor, blocks, notification settings, custom emoji, GIF favourites, room groups and sidebar order.
- DMs and friends are per server. A user is always shown with their server, so "DM bob" is never ambiguous.
- Mention, unread, notification-level and sound rules run per server, against that server's version of the rules.
- Voice: one call at a time across all servers. Joining a call on another server leaves the current one first.
- The merged sidebar's order is a client-side layer on top of each server's own order, stored on the device.

## Version skew

Today client and server ship together. Under multi-server the client talks to servers at other versions, and can be newer than any of them. Each server gets a `GET /api/server-info` endpoint returning `{name, icon, version, capabilities: [..]}`, and the client checks capabilities before using anything newer than its baseline. The additive-only rule still applies on the server. A server too old to have `/api/server-info` is refused with a clear message.

## Notifications

- **Web Push:** a subscription is tied to one server's push key, so a page served by A can't really receive B's pushes. Another reason the web client stays single-server.
- **Android:** one push registration per server, each tracked by its own server.
- **Desktop:** in-page notifications as today, fed by every session's socket. The unread badge (`"(N) Chatter"` in `document.title`) sums across servers.

## Core shape

- `api.ts` becomes an `ApiClient` class: origin, tokens, refresh state and upload helpers per instance. The current exports stay as wrappers around a default client, so nothing has to move at once.
- **Per-server state merged when reading** rather than a prefix on every ID: a `sessions: Record<serverId, AppState>` map. The existing reducer and `wsHandler` run unchanged, one copy per server, and combined selectors build the room list, unread totals and mention counts. Wherever a room or user leaves its session (navigation, links, the call engine), it travels as `{serverId, id}`.
- `serverId` is the normalized origin (as `normalizeServer` in mobile produces).
- Shared settings that are really per device (voice settings, themes) stay global.

## Order of work

One step at a time, each tested before the next:

1. **`ApiClient` refactor in core.** No behaviour change; core `npm run check`, web build and mobile typecheck all pass.
2. **Server:** `GET /api/server-info`, plus cross-origin access for token-based auth on the API and WebSocket. Backward compatible.
3. **Core sessions map:** one socket and state per server, combined selectors, `{serverId, id}` references.
4. **Android:** add-server flow, tokens per server in the Keystore, merged sidebar labelled by server.
5. **Desktop:** tokens in the main process through new optional bridge members behind a feature string (`bridge.ts` changes additively only; see `desktop.md`).
6. **Push per server** on Android.
7. **Web:** stays single-server unless the host-trust decision changes.

Shortcut: the server rail can ship on desktop and mobile before step 1 if a quick win is wanted.

## Open questions

- Does status (online/idle/DND) sync across servers, or stay per server? (MVP: per server.)
- Should the sidebar group rooms by server, or interleave them with a server badge per room? (MVP: grouped.)
- Should the desktop app keep loading the client from one "home" server, or ship its own copy of the client for multi-server mode? Shipping its own copy removes the host-trust issue on desktop entirely, but ends updating the client on every server deploy.
