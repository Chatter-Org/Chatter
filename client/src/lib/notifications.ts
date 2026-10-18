/**
 * Desktop notification policy.
 *
 * The server sends every message a member is entitled to see; these rules
 * decide only whether one becomes a desktop notification. Keeping the decision
 * pure makes it testable without a browser.
 */

export type NotificationLevel = "all" | "mentions" | "none";

/** Levels keyed by `${room_id}|${channel_id}`; a room-wide entry uses an empty channel. */
export type NotificationSettings = Record<string, NotificationLevel>;

/** Applied when neither the channel nor its room has an explicit setting. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = "all";

export function settingsKey(roomId: string, channelId?: string | null): string {
  return `${roomId}|${channelId ?? ""}`;
}

/**
 * A channel override wins over its room's setting, which wins over the default.
 * An explicit room-level "none" is therefore still overridable per channel —
 * muting a room but keeping one channel loud is the common case.
 */
export function resolveNotificationLevel(
  settings: NotificationSettings,
  roomId: string,
  channelId?: string | null,
): NotificationLevel {
  if (channelId) {
    const channelLevel = settings[settingsKey(roomId, channelId)];
    if (channelLevel) return channelLevel;
  }
  return settings[settingsKey(roomId, "")] ?? DEFAULT_NOTIFICATION_LEVEL;
}

export interface NotifyDecision {
  level: NotificationLevel;
  isMention: boolean;
  /** DMs bypass "all vs mentions": a direct message is always addressed to you. */
  isDm: boolean;
  /** True when the user is already looking at this exact channel in a focused tab. */
  isViewing: boolean;
  /** The user's own presence; "dnd" suppresses everything. */
  presence?: string;
}

/** Whether a newly arrived message should raise a desktop notification. */
export function shouldNotify({
  level,
  isMention,
  isDm,
  isViewing,
  presence,
}: NotifyDecision): boolean {
  if (presence === "dnd") return false;
  // Already on screen — a notification would only duplicate what they can see.
  if (isViewing) return false;
  if (level === "none") return false;
  if (level === "mentions") return isMention || isDm;
  return true;
}

/** Current browser permission, or "unsupported" where the API is absent. */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Must be called from a user gesture, or browsers reject the prompt. */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface DesktopNotification {
  title: string;
  body: string;
  icon?: string;
  /** Collapses repeat notifications from the same channel into one. */
  tag?: string;
  /** The message's server timestamp, so a read on another device can tell
   *  whether it covered this notification (`closeReadNotifications`). */
  ts?: number;
  onClick?: () => void;
}

/** The in-page notification currently showing under each tag, and the
 *  timestamp of the message it stands for. A tag collapses a burst into one
 *  notification, so the latest is the only one there is to close. */
const shown = new Map<string, { notification: Notification; ts: number }>();

/**
 * Show a notification, ignoring the request when permission is missing.
 * Returns whether one was actually raised.
 */
export function showDesktopNotification(n: DesktopNotification): boolean {
  if (notificationPermission() !== "granted") return false;
  try {
    const notification = new Notification(n.title, {
      body: n.body,
      icon: n.icon,
      tag: n.tag,
    });
    if (n.tag) {
      const tag = n.tag;
      shown.set(tag, { notification, ts: n.ts ?? Date.now() });
      notification.addEventListener("close", () => {
        if (shown.get(tag)?.notification === notification) shown.delete(tag);
      });
    }
    if (n.onClick) {
      notification.onclick = () => {
        window.focus();
        n.onClick!();
        notification.close();
      };
    }
    return true;
  } catch {
    // Some browsers throw when constructing outside a service worker.
    return false;
  }
}

/** The tag a channel's (or a channel-less room's) notifications collapse under.
 *  The server's push payload builds the same string — change both together. */
export function channelNotificationTag(roomId: string, channelId: string): string {
  return `${roomId}|${channelId}`;
}

export function threadNotificationTag(roomId: string, threadId: string): string {
  return `${roomId}|thread|${threadId}`;
}

/**
 * Close the notifications under `tag` whose message was read — at or before
 * `lastReadTs` — and leave the rest. A message that arrived after the point
 * read on another device is still unread, so its notification stays.
 *
 * Covers both kinds a device can be showing: the in-page ones this tab raised
 * off the socket, and the ones the service worker raised from a push while
 * no tab was open. Best effort throughout: a browser without a worker, or one
 * that will not list its notifications, simply keeps them.
 */
export async function closeReadNotifications(tag: string, lastReadTs: number): Promise<void> {
  const local = shown.get(tag);
  if (local && local.ts <= lastReadTs) {
    local.notification.close();
    shown.delete(tag);
  }
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    for (const n of await registration.getNotifications({ tag })) {
      // A push from before payloads carried `ts` falls back to when it was
      // shown, which is never earlier than the message it announced.
      // `timestamp` is real but missing from TypeScript's DOM types.
      const shownAt = (n as Notification & { timestamp?: number }).timestamp ?? 0;
      const ts = typeof n.data?.ts === "number" ? n.data.ts : shownAt;
      if (ts <= lastReadTs) n.close();
    }
  } catch {
    // Nothing to close, or no way of finding it.
  }
}

/**
 * Close every channel notification whose channel has nothing unread left.
 *
 * The `read_marker` broadcast only reaches a device whose socket is open, and
 * a phone's is not while the app sits in the background — which is exactly
 * when its tray fills with pushes. When it comes back and reloads its unreads
 * (`loadUnreads`), whatever was read elsewhere meanwhile is cleared here.
 * `stillUnread` holds `channelNotificationTag` keys with something unread.
 *
 * Channels only: a thread's unread state is counted in mentions, so a reply
 * that named nobody reads as zero and would be closed unread. Thread, forum
 * and event notifications are left for the live broadcast or the person.
 */
export async function closeNotificationsReadElsewhere(stillUnread: Set<string>): Promise<void> {
  const isChannelTag = (tag: string) => !/\|(thread|forum|event)\|/.test(tag);
  for (const [tag, entry] of shown) {
    if (isChannelTag(tag) && !stillUnread.has(tag)) {
      entry.notification.close();
      shown.delete(tag);
    }
  }
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    for (const n of await registration.getNotifications()) {
      const data = n.data || {};
      if (!data.roomId || data.threadId || data.postId || data.panel) continue;
      if (!isChannelTag(n.tag)) continue;
      if (!stillUnread.has(channelNotificationTag(data.roomId, data.channelId || ""))) n.close();
    }
  } catch {
    // Nothing to close, or no way of finding it.
  }
}

/** Trim a message body to something that reads well in a notification. */
export function notificationBody(body: string, max = 140): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
