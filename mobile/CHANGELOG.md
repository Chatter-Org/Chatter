# What's new in Chatter for Android

<!--
How to keep this up to date:

- Write for the people using the app, not for developers: what changed for
  them, in plain words. No file names, no jargon.
- Add to "Unreleased" as changes land, under New, Changed or Fixed.
- When releasing, rename "Unreleased" to the version and date, e.g.
  "## 0.2.0 — November 2, 2026", and tag mobile-v0.2.0 (see RELEASING.md).
  That section becomes the GitHub Release's notes.
- After any edit, run `npm run changelog` so Settings → What's new in the app
  shows the same thing. CI fails if you forget.
-->

## 0.2.0 — October 25, 2026

### New
- Theater channels work on your phone. Watch together in sync: YouTube links, uploaded videos or any video link. Play, pause and skip for everyone, react with emoji at a moment in the video, and see who's watching. Turn your phone on its side for a bigger picture.
- Whiteboard channels work on your phone. Draw together live with the pen, eraser, lines, rectangles, ellipses and fill, in any colour and size. Pinch to zoom, undo your last stroke, and send the board into the chat as a picture.
- Cast videos to your TV. Tap the cast button on a video in a message to play it on a Chromecast.
- Report a message to a server's moderators: hold it and choose Report.
- Server owners and moderators can mute, move or disconnect people in a voice channel: tap the shield next to their name.
- Links to channels (#channel-name) in messages show as tappable pills that take you there.
- If you're timed out, or a server asks you to accept its rules first, the message box says so, and you can read and accept the rules right there.
- You can turn vibration off. Settings → Appearance → Haptic feedback.
- Settings → What's new shows these notes in the app.

### Changed
- Much less buzzing. The phone only vibrates to confirm a gesture now: when a swipe is far enough to reply, when holding a message opens its actions, and when push to talk goes live. Tapping channels, servers, menus, call buttons and Send no longer vibrates.
- The message box is more compact. Its text is the same size as the messages, and the "is typing" line only shows while someone is typing instead of always taking up space.

### Fixed
- Channels remember your place. A channel opens at the "New" line if messages came in while you were away, where you left off if you had scrolled up, and otherwise at the newest message.
- Opening a channel no longer loads a page of older messages it didn't need, so channels open faster.
- Typing @ in a forum post or reply now suggests people and roles, as it does in chat.
- Pictures, videos and files from other websites (a GIF, for example) no longer receive your sign-in. It only goes to your own Chatter server.

## 0.1.0 — October 18, 2026

The first release of Chatter for Android.

### New
- Chat with swipes: swipe right for servers and channels, swipe a message to reply, hold it for reactions, copy, edit and more.
- Direct messages, friends, threads, pins, search, polls, events and forums.
- Voice and video calls that keep running in the background, with push to talk, screen sharing, your camera and picture-in-picture.
- Notifications while the app is open or recently used, and sharing into Chatter from other apps.
- All of the web's themes, plus your own custom themes, synced with your account.
- Foldable and tablet layouts: side-by-side panels, book and tabletop postures.
