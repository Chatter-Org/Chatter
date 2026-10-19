/**
 * Notification policy, shared by every client.
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

export interface DesktopNotification {
  title: string;
  body: string;
  icon?: string;
  /** Collapses repeat notifications from the same channel into one. */
  tag?: string;
  /** The message's server timestamp, so a read on another device can tell
   *  whether it covered this notification (`closeReadNotifications`). */
  ts?: number;
  /** Where opening it leads. `onClick` goes there too; this is the same
   *  destination as data, for a host whose notification outlives the page
   *  or process that raised it (a phone's notification shade). */
  target?: NotificationTarget;
  onClick?: () => void;
}

/** A notification's destination: the payload of `notification-navigate`. */
export interface NotificationTarget {
  roomId: string;
  channelId?: string;
  threadId?: string;
  postId?: string;
  panel?: "events";
}

/**
 * A destination as query parameters — `room`, `channel`, `thread`, `post`,
 * `panel` — the form a push opens the web app with (`sw.js`) and the phone's
 * `chatter://open?…` links use.
 */
export function notificationTargetQuery(target: NotificationTarget): string {
  const params = new URLSearchParams();
  params.set("room", target.roomId);
  if (target.channelId) params.set("channel", target.channelId);
  if (target.threadId) params.set("thread", target.threadId);
  if (target.postId) params.set("post", target.postId);
  if (target.panel) params.set("panel", target.panel);
  return params.toString();
}

/** The destination in a query (`notificationTargetQuery`), or null without a room. */
export function notificationTargetFromQuery(params: URLSearchParams): NotificationTarget | null {
  const roomId = params.get("room");
  if (!roomId) return null;
  return {
    roomId,
    channelId: params.get("channel") || undefined,
    threadId: params.get("thread") || undefined,
    postId: params.get("post") || undefined,
    panel: params.get("panel") === "events" ? "events" : undefined,
  };
}

/** The tag a channel's (or a channel-less room's) notifications collapse under.
 *  The server's push payload builds the same string — change both together. */
export function channelNotificationTag(roomId: string, channelId: string): string {
  return `${roomId}|${channelId}`;
}

export function threadNotificationTag(roomId: string, threadId: string): string {
  return `${roomId}|thread|${threadId}`;
}

/** Trim a message body to something that reads well in a notification. */
export function notificationBody(body: string, max = 140): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
