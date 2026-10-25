/**
 * What the shared core asks of the app it runs inside.
 *
 * The core holds Chatter's protocol and state rules and is shared by the web
 * client (which the desktop app also loads) and the mobile app. Anything that
 * differs between them — how a toast looks, how a sound plays, whether the
 * person is looking at the app, where the server lives — comes through here.
 * Each app calls `configureHost` once at startup with its own implementations.
 *
 * The defaults are inert, so the core runs (and its tests run) with no browser
 * and no phone: nothing is shown, nothing plays, and the person counts as
 * looking away.
 */

import type { DesktopNotification } from "./notifications";
import type { SoundEvent, SoundPack } from "./soundRules";

export interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export interface Host {
  /** The origin links are built against and parsed relative to, e.g.
   *  `https://chatter.example`. The web client is served from it; the mobile
   *  app is configured with it. */
  origin(): string;
  /** Whether the person is looking at the app right now — a focused tab, a
   *  foregrounded app. Gates notifications for what is already on screen. */
  hasFocus(): boolean;
  /** Broadcast an event to the rest of the app. The web client listens on
   *  `window`; the payload is the CustomEvent `detail`. */
  emit(type: string, detail?: unknown): void;

  toast(message: string, options?: ToastOptions): void;
  toastError(message: string): void;

  /** Raise a notification. Returns whether one was actually shown. */
  notify(notification: DesktopNotification): boolean;
  /** Close notifications under `tag` covering messages at or before `lastReadTs`. */
  closeReadNotifications(tag: string, lastReadTs: number): Promise<void>;
  /** Close channel notifications whose channel has nothing unread left —
   *  `stillUnread` holds `channelNotificationTag` keys that do. */
  closeNotificationsReadElsewhere(stillUnread: Set<string>): Promise<void>;

  playSound(event: SoundEvent, pack?: SoundPack): void;
  playSoundUrl(url: string, gain?: number): void;
  /** Hold an arrival sound until the voice connection it announces is up. */
  deferArrivalSound(sound: { url: string; gain: number } | null): void;
  /** Play the held arrival sound, once (the voice connection came up). */
  playDeferredArrivalSound(): void;
  /** Forget the held arrival sound (the call it announced is not happening). */
  dropDeferredArrivalSound(): void;
  /** Warm anything a first sound would otherwise wait on: the built-in
   *  effects with no list, or these sound files (a room's pack). */
  prewarmSounds(urls?: string[]): void;

  /** The server sent the account's GIF favourites; hand them to whatever keeps them. */
  adoptGifFavorites(payload: unknown): void;

  /** Hand the person a file — a browser download, a share sheet. */
  saveFile(blob: Blob, filename: string): void;
}

const inert: Host = {
  origin: () => "",
  hasFocus: () => false,
  emit: () => {},
  toast: () => {},
  toastError: () => {},
  notify: () => false,
  closeReadNotifications: async () => {},
  closeNotificationsReadElsewhere: async () => {},
  playSound: () => {},
  playSoundUrl: () => {},
  deferArrivalSound: () => {},
  playDeferredArrivalSound: () => {},
  dropDeferredArrivalSound: () => {},
  prewarmSounds: () => {},
  adoptGifFavorites: () => {},
  saveFile: () => {},
};

let current: Host = inert;

/** The app's implementations. Fields left out keep their inert default. */
export function configureHost(overrides: Partial<Host>): void {
  current = { ...current, ...overrides };
}

/** Back to the inert defaults. For tests. */
export function resetHost(): void {
  current = inert;
}

/** The host, read at call time so a later `configureHost` takes effect. */
export const host: Host = new Proxy({} as Host, {
  get: (_target, key: keyof Host) => current[key],
});
