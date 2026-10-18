# Chatter mobile — roadmap

The Android app (iOS later from the same code) for Chatter, built with Expo /
React Native on top of `packages/core`, the protocol and state code it shares
with the web client. The goal is the web's look and features, laid out and
behaving like a phone app: gestures, back, sheets, notifications, foldables.

FCM push notifications are deliberately **last**: everything else first.

## How it fits together

| Piece | Where | Shared with web |
| --- | --- | --- |
| API, store reducer, socket handling, actions, message format | `packages/core` | yes — same files |
| Platform glue: storage, Keystore session, server choice, host (toasts, sounds, notifications) | `mobile/src/platform` | no |
| Screens and components | `mobile/src/app`, `mobile/src/components` | no (same design tokens and classNames) |
| Theme tokens | generated from `client/src/index.css` by `npm run port-theme` | yes — one palette |
| Native modules (calls, fold posture, …) | `mobile/modules` (Expo Modules, Kotlin) | no |

## Status

### Foundation — done
- [x] `packages/core` extracted; web runs on it unchanged (tests, build, Docker)
- [x] Shared store actions (rooms, channels, history, send/edit/delete, reactions, typing, drafts, unreads, presence, catch-up)
- [x] Shared message format parser (web rules, unit-tested)
- [x] Expo SDK 58 app, dev variant `io.zgaf.chatter.dev` beside a release `io.zgaf.chatter`
- [x] Uniwind (Tailwind 4) with all 8 web themes + a runtime custom-theme slot
- [x] Session in the Keystore; restore with backoff; device-only sign-out (server change)
- [x] Socket lifecycle for a phone: foreground/background, catch-up on resume
- [x] Server choice on sign-in (self-hosted servers), https enforced outside dev builds
- [x] Windows build fixed reproducibly (CMake 3.31 via config plugin)
- [x] Local dev server + seed script (`scripts/dev-backend.ps1`, `scripts/seed-dev.mts`)

### Core chat
- [x] Panels: swipe right for channels, edge-swipe left for members, Back closes; side-by-side when wide
- [x] Server rail, channel list with categories, unread/mention badges, voice occupants
- [x] Timeline: grouping, day dividers, replies, mentions, code, links, custom emoji, spoilers, edited
- [x] Swipe a message to reply; hold for actions (react, reply, copy, link, edit, delete)
- [x] Composer above the keyboard; drafts synced; typing indicator
- [x] Message images open full screen (pinch, swipe to dismiss); video/audio/file cards
- [ ] Link previews and embeds (bot embeds, message/forum link cards, YouTube)
- [x] Emoji picker (standard + room custom emoji), reaction picker
- [x] Mention autocomplete (@user, @role) and :emoji: shortcodes in the composer (`composerTokens` in core)
- [ ] Threads (open, reply, previews under channels)
- [ ] Pins, search, mentions inbox
- [ ] Polls (vote, results) and events (RSVP)
- [ ] Unread marker line and "jump to unread"
- [ ] Profiles: open a member, DM them, roles, profile themes and name fonts
- [ ] Friends and DMs: start a DM, group DMs, friend requests

### Uploads
- [x] Attach from gallery, camera, files; progress; chunked resumable upload (`uploadResume` in core)
- [ ] Share into Chatter from other apps (Android share sheet)
- [x] Save/share received files

### Forums
- [ ] Forum channels: post list, tags, open a post, comment, create a post with images

### Voice and video
- [x] Shared `VoiceEngine` in core (`packages/core/src/voice/engine.ts`), ported from `useWebRTCVoice`, on a `react-native-webrtc` backend (`src/voice/nativeBackend.ts`)
- [x] **Web:** `useWebRTCVoice` adopts `VoiceEngine`, so web, desktop and mobile share one call implementation
- [x] Join/leave, mute/deafen, slots, per-person volume, speaking rings, rejoin after a dropped socket
- [x] Push-to-talk: switch in the call sheet, hold-to-talk on the bar
- [x] Calls keep running in the background: foreground service with Mute/Leave in its notification, wake and Wi-Fi locks (`modules/chatter-call`)
- [ ] ConnectionService (self-managed Telecom): a phone call interrupting, car/watch controls
- [x] Audio routing: speaker by default, headsets win when connected, tap to switch
- [ ] Proximity screen-off while on the earpiece
- [ ] Spatial channels' floor (heard by distance today, no map yet)
- [ ] Watch screen shares and webcams; picture-in-picture
- [ ] Share screen (MediaProjection) and camera

### Design (match the web)
- [x] Shared control recipes (`packages/core/src/ui/recipes.ts`) used by the web's shadcn files and `src/ui/controls.tsx`; the web's 17.6px rem
- [x] Drawer (rail + channel list), header, messages, composer, members, call bar, sheets, settings, sign-in rebuilt from the web components
- [ ] Header tool row (notifications, events, pins, mentions, search) as those features land
- [ ] GIF picker and the composer's GIF button

### Adaptive layout
- [x] Side-by-side panels on wide windows
- [ ] Fold posture module (Jetpack WindowManager): hinge-aware split, tabletop mode for calls
- [ ] Tablet/landscape polish

### Settings (native screens)
- [x] Appearance: Match phone + the 8 web themes
- [ ] Custom themes (sync from web; editor)
- [ ] Notifications per server/channel (same levels as the web)
- [ ] Voice: input/output, push-to-talk, noise suppression
- [ ] Account: profile, avatar, status, sessions, 2FA status
- [ ] Data: media autoplay, image quality, cache

### Notifications
- [ ] In-app banners while the app is open (host.notify)
- [ ] Local notifications while the socket is alive in the background
- [ ] Tapping a notification opens the conversation (deep links: `chatter://`)
- [ ] **Last:** FCM push — device token registration endpoint, FCM sender beside `webpush.rs`, the same mute rules (`push.rs`), mobile-aware "connected" gate

### Release
- [ ] App icon/splash in Chatter's identity
- [ ] Release signing, versioning, EAS build profile
- [ ] Replace the Kotlin app (`io.zgaf.chatter`)

## Backend changes made for mobile

- `0a76488` — `/logout` with `{ "refresh_token" }` signs out one device; tokens get a random `jti` (two sessions minted in the same second used to share one refresh token).

## Known issues found along the way (not mobile's)

- `tests/http_contract.rs` fails at register (500): the suite predates mandatory TOTP enrolment.
- The web login screen's halftone background throws when laid out at zero width (`createImageData`).

## Developing

```powershell
# once: cargo build at the repo root
mobile\scripts\dev-backend.ps1            # private MongoDB on :27018 + server on :8000
npx tsx --tsconfig scripts/tsconfig.json scripts/seed-dev.mts   # accounts + a test server
adb reverse tcp:8000 tcp:8000; adb reverse tcp:8081 tcp:8081
npm start                                  # Metro, for the dev build
```
