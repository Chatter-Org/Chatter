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
- [x] Link previews and embeds (message/forum link cards, page previews, YouTube); jumping to a linked message
- [x] Bot rich embeds: author, title link, description, fields, thumbnail, image, footer, BOT/HOOK tag; buttons and select menus answer the bot over the socket
- [x] Emoji picker (standard + room custom emoji), reaction picker
- [x] Mention autocomplete (@user, @role) and :emoji: shortcodes in the composer (`composerTokens` in core)
- [x] Threads (open, reply, previews under channels)
- [x] Pins, search, mentions inbox (the web's MessagePanel as a screen); per-channel notification level from the header
- [x] Polls: vote, voters, end early, results; create from the composer's + sheet
- [x] Events: the header's events button (live/soon dot), RSVP, guest list, add to calendar (.ics share); schedule, edit, cancel, delete with the phone's date and time pickers
- [x] Unread marker line and "jump to unread" (the web's "New" line and unread bar)
- [x] Profiles: a sheet from any avatar, name or member (banner, status, about, Steam game, mutual friends, roles, profile colour); Message, friend and block from it
- [x] Name fonts (people's own fonts on their names): in messages, the member list and profiles; fetched with the session and cached; checked with a .ttf (a .woff or .woff2 that Android will not load stays in the app's font; not yet tried on a device)
- [x] Friends and DMs: new message / group DM picker, adding people to a DM, Friends screen (requests, pending, add by username, blocked)

### Uploads
- [x] Attach from gallery, camera, files; progress; chunked resumable upload (`uploadResume` in core)
- [x] Share into Chatter from other apps (Android share sheet): text, links, pictures and files, one or several (`modules/chatter-share`); pick a DM or a server's text channel, and it waits in that conversation's box to be finished and sent
- [x] Save/share received files

### Forums
- [x] Forum channels: post list (search, sort, tag filters, pins first, pull to refresh, live), open a post (Markdown, media, reactions, threaded replies with folding), comment and reply with attachments, edit and delete, create and edit a post with tags and up to ten attachments; forum links open the post
- [x] Forum tag set-up (the web's Manage tags dialog): name, colour (or none), add and remove, up to twenty, with a preview; for the forum's creator and anyone who can manage channels

### Voice and video
- [x] Shared `VoiceEngine` in core (`packages/core/src/voice/engine.ts`), ported from `useWebRTCVoice`, on a `react-native-webrtc` backend (`src/voice/nativeBackend.ts`)
- [x] **Web:** `useWebRTCVoice` adopts `VoiceEngine`, so web, desktop and mobile share one call implementation
- [x] Join/leave, mute/deafen, slots, per-person volume, speaking rings, rejoin after a dropped socket
- [x] Push-to-talk: switch in the call sheet, hold-to-talk on the bar
- [x] Calls keep running in the background: foreground service with Mute/Leave in its notification, wake and Wi-Fi locks (`modules/chatter-call`)
- [ ] ConnectionService (self-managed Telecom): a phone call interrupting, car/watch controls
- [x] Audio routing: speaker by default, headsets win when connected, tap to switch
- [x] Proximity screen-off while on the earpiece (`ProximityLock` in `modules/chatter-call`, following the audio route; not yet tried on a phone with an earpiece — the emulators have none)
- [ ] Spatial channels' floor (heard by distance today, no map yet)
- [x] Watch screen shares and webcams: the shared `StreamViewer` (core) on react-native-webrtc; "is streaming / View stream" bar, LIVE buttons in the call sheet, a full-screen viewer with a strip to switch feeds; opt-in like the web (nothing is fetched until the viewer is open)
- [x] Picture-in-picture: leaving the app while watching (or the button) floats the stream over other apps, just the picture
- [x] Camera: send this phone's camera to the call (the shared `StreamPublisher`), mirrored self-preview, switch lenses, off from the call sheet or the viewer
- [ ] Share screen (MediaProjection)
- [ ] Picture-in-picture window shaped to the stream (it is 16:9 for now; a portrait camera has bars)

### Design (match the web)
- [x] Shared control recipes (`packages/core/src/ui/recipes.ts`) used by the web's shadcn files and `src/ui/controls.tsx`; the web's 17.6px rem
- [x] Drawer (rail + channel list), header, messages, composer, members, call bar, sheets, settings, sign-in rebuilt from the web components
- [x] Header tool row: notifications, pins, mentions, search
- [x] Events in the tool row (with polls/events)
- [x] GIF picker (from the composer's + sheet): search, trending first; favourites and categories synced with the account; hold a GIF anywhere to favourite or file it

### Adaptive layout
- [x] Side-by-side panels on wide windows
- [x] Fold posture module (`modules/chatter-fold`, Jetpack WindowManager): the window's hinges, live as the phone folds and bends
- [x] Book posture: an unfolded foldable splits at the hinge, channels on one side and the conversation on the other, nothing in the crease
- [x] Tabletop posture: half open on its side, the conversation sits above the hinge and the composer below it
- [ ] Tabletop for calls: video and screen shares above the hinge, controls below (with screen and webcam viewing)
- [x] Tablets: three columns (channels, conversation, members); a thread opens beside the conversation in place of the members, and the members button swaps back
- [x] Pushed screens (settings, profiles, a post) keep to a 760 dp reading column on wide windows
- [x] Sheets on wide windows are a centred 640 dp column (Material's large-screen bottom sheet), never taller than below the status bar

### Settings (native screens)
- [x] Appearance: Match phone + the 8 web themes
- [x] Custom themes: synced with the account both ways (the web's appearance settings), editor with palette picker, derived-colour overrides, contrast check and live preview; import and share codes
- [x] Notifications: every server's and DM's level in one place (channels from their bell); sound effects on/off and volume, played with expo-audio
- [x] Voice: voice activity or push to talk, output volume, mic test (processing and the audio route are Android's / the call bar's)
- [x] Profile: name, status, about, avatar and banner, availability
- [x] Account: 2FA status and set-up (opens the authenticator), recovery codes, password, sessions, delete account
- [x] Data: animated pictures, link previews, cache size and clearing

### Notifications
- [x] In-app banners while the app is open (host.notify): who and where, the message; tap to go there, push up to dismiss; a read elsewhere takes it away
- [x] Local notifications while the socket is alive in the background (the grace period, and calls), on a "Messages" channel with the web's badge as the icon; reads close them, as on the web
- [x] Tapping a notification opens the conversation, thread, forum post or events, including after Android restarted the app; `chatter://open?room=…&channel=…&thread=…&post=…&panel=…` links do the same (the query the web's push opens with)
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
