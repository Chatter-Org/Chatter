// Generated from CHANGELOG.md by scripts/changelog.mjs (npm run changelog).
// Don't edit by hand.

export interface ChangelogRelease {
  /** "0.2.0", or "Unreleased" for what is in development. */
  version: string;
  date: string | null;
  intro: string | null;
  groups: { title: string; items: string[] }[];
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    "version": "Unreleased",
    "date": null,
    "intro": null,
    "groups": [
      {
        "title": "New",
        "items": [
          "You can turn vibration off. Settings → Appearance → Haptic feedback."
        ]
      },
      {
        "title": "Changed",
        "items": [
          "Much less buzzing. The phone only vibrates to confirm a gesture now: when a swipe is far enough to reply, when holding a message opens its actions, and when push to talk goes live. Tapping channels, servers, menus, call buttons and Send no longer vibrates.",
          "The message box is more compact. Its text is the same size as the messages, and the \"is typing\" line only shows while someone is typing instead of always taking up space."
        ]
      },
      {
        "title": "Fixed",
        "items": [
          "Channels remember your place. A channel opens at the \"New\" line if messages came in while you were away, where you left off if you had scrolled up, and otherwise at the newest message.",
          "Opening a channel no longer loads a page of older messages it didn't need, so channels open faster.",
          "Typing @ in a forum post or reply now suggests people and roles, as it does in chat."
        ]
      }
    ]
  },
  {
    "version": "0.1.0",
    "date": "October 18, 2026",
    "intro": "The first release of Chatter for Android.",
    "groups": [
      {
        "title": "New",
        "items": [
          "Chat with swipes: swipe right for servers and channels, swipe a message to reply, hold it for reactions, copy, edit and more.",
          "Direct messages, friends, threads, pins, search, polls, events and forums.",
          "Voice and video calls that keep running in the background, with push to talk, screen sharing, your camera and picture-in-picture.",
          "Notifications while the app is open or recently used, and sharing into Chatter from other apps.",
          "All of the web's themes, plus your own custom themes, synced with your account.",
          "Foldable and tablet layouts: side-by-side panels, book and tabletop postures."
        ]
      }
    ]
  }
];
