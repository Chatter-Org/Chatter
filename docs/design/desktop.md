# Desktop app contract and voice media backends

The desktop app (Chatter-Desktop, Electron) loads this client from the server and adds `window.chatterDesktop`. Read before changing `client/src/lib/desktop/`, `client/src/lib/media/`, or anything the desktop app relies on.

Moved verbatim from the root AGENTS.md; keep it current when you change the behaviour it describes.

The Chatter desktop app (Chatter-Desktop, Electron) loads this same client from the server, exactly as a browser does, and adds `window.chatterDesktop` before the page runs. In a browser it is absent and nothing changes. Keep the web client working on its own; desktop paths are always `if (desktop)` extras.

- `client/src/lib/desktop/bridge.ts` - The bridge's types and the `desktop` / `hasDesktopFeature()` helpers. It is the contract the desktop app type-checks against: change it additively only, never rename a field or a feature string.
- Check `hasDesktopFeature("…")` before using anything past the base fields. This client updates on every deploy; installed desktop apps lag behind.
- What the desktop app changes today:
  - The first WebSocket frame carries `client: {kind: "desktop", version}`. The server records it (`desktop_connections`) so push only treats a desktop socket as "someone will see it" while the user is active (`push.rs`, `attended_users`) — a tray app stays connected all day.
  - `pushSupport()` returns `"desktop"`: Electron has a PushManager with no push service behind it. The app notifies from the tray through the ordinary in-page notifications.
  - Push-to-talk (feature `ptt`): the app watches a key system-wide and reports press/release through `desktop.pushToTalk`, replacing the in-window backtick listener in `useWebRTCVoice`.
  - The unread badge comes from `document.title` (`"(N) Chatter"`); keep that format.
  - Screen sharing goes through `selectDisplayCapture()` (lib/media). With feature `app-audio@1` the desktop app's picker also chooses the audio — the shared app's own sound, or everything except Chatter — captured natively and added to the stream as an ordinary audio track.
  - Camera avatars (feature `avatars@1`): a VRM avatar in place of the camera, offered in `CameraSelectModal` only when the app has the feature. The app keeps the `.vrm` files as plain files in its own folder (`userData/avatars`), so people manage them from Chatter or their file manager; the bridge (`DesktopAvatars`) lists them by file name, adds them through the app's own file picker, reads one's bytes, moves one to the trash, opens the folder, and says when the folder changes. The page never sees a path. The drawing is the client's (`avatarCamera.ts`; see `voice.md`), and browsers have avatars too, kept in IndexedDB (`avatarStore.ts`).
  - Game activity (feature `game-activity`): the desktop app reports the game it sees running; the client sends `{type: "game_activity", game}` and the server shows it in `steam_game` when Steam isn't reporting one (`set_desktop_game` in `ws/session.rs`). `hide_steam_game` hides both.
- Media goes through `client/src/lib/media/` (see Voice media backends below) so the desktop app can supply a native voice engine. Don't call `new RTCPeerConnection` / `getUserMedia` for voice directly in hooks.

### Voice media backends

`useWebRTCVoice` keeps everything Chatter-specific (signalling, retries, SDP munging, slots, moderation) and gets its media from a `VoiceMediaBackend` (`client/src/lib/media/types.ts`):

- `createPeer()` returns a `VoicePeer`, the subset of `RTCPeerConnection` voice uses. In a browser it *is* an RTCPeerConnection; the desktop engine provides a stand-in with the same behaviour. Only use what the interface declares.
- `acquireMic()` returns a `LocalMic` (`attachTo`, `setEnabled`, `isSpeaking`, `update`, `stop`). Mute and push-to-talk go through `setEnabled`; settings changes through `update`.
- The playout graph (`attachSlot`, `setSlotGain`, `setSlotPosition`, `setListenerPosition`, `setOutput`, `closeGraph`) is keyed by slot. Compute gains and positions in the hook; the backend only applies them.
- `browserVoice.ts` is the implementation every browser uses. `selectVoiceBackend()` picks the desktop engine when the app offers one (feature `voice-backend@1`) and the person hasn't switched it off.
- `types.ts` is part of the desktop contract: change it additively. A new capability means a new optional member and a new feature string.
- Voice settings live in one shared store (`useVoiceSettings`); the running call applies changes live.
