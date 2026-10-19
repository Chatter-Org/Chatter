import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { AndroidImportance, AndroidNotificationVisibility } from "expo-notifications";
import type { DesktopNotification, NotificationTarget } from "@chatter/core/notifications";
import { channelNotificationTag } from "@chatter/core/notifications";
import { emit } from "./events";
import { dismissBanner, showBanner } from "./banner";

/**
 * The phone's notifications: the host's `notify` and the closing that follows
 * a read (packages/core/src/platform.ts).
 *
 * The shared rules (notifications.ts in core) have already decided a message
 * is worth telling the person about. What is left is how:
 *
 * - In the app, a banner across the top (banner.ts), as the person is
 *   already looking at the phone and only at another conversation.
 * - Put away, an Android notification, while the socket is still up: the
 *   grace period after leaving and the whole of a call. Past that the server
 *   reaches the phone by push instead.
 *
 * A notification carries its destination as data rather than as a callback,
 * so tapping one still lands after Android has restarted the app; both ways
 * of opening it come out as the core's `notification-navigate` event.
 */

/** Android's channel for messages: one the person can tune in system settings. */
const MESSAGES_CHANNEL = "messages";

interface NotificationData {
  tag?: string;
  ts?: number;
  target?: NotificationTarget;
}

let channelReady: Promise<unknown> | null = null;

function ensureChannel() {
  if (Platform.OS !== "android") return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
    name: "Messages",
    description: "Messages, mentions, replies in threads and event reminders",
    importance: AndroidImportance.HIGH,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  }).catch(() => {});
  return channelReady;
}

/** The host's `notify`: a banner in the app, a notification outside it. */
export function notify(n: DesktopNotification): boolean {
  if (AppState.currentState === "active") {
    showBanner({
      key: n.tag ?? `${Date.now()}`,
      title: n.title,
      body: n.body,
      icon: n.icon,
      onPress: n.onClick,
    });
    return true;
  }
  void present(n);
  return true;
}

async function present(n: DesktopNotification) {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== "granted") return;
    await ensureChannel();
    const data: NotificationData = { tag: n.tag, ts: n.ts ?? Date.now(), target: n.target };
    await Notifications.scheduleNotificationAsync({
      // The same tag replaces the one before it, so a burst in one channel
      // is one notification with the latest message, as on the web.
      identifier: n.tag,
      content: { title: n.title, body: n.body, data: data as Record<string, unknown> },
      trigger: Platform.OS === "android" ? { channelId: MESSAGES_CHANNEL } : null,
    });
  } catch {
    // Not shown; nothing else to do about it.
  }
}

/** Notifications showing now, with the data they were raised with. */
async function presented(): Promise<{ id: string; data: NotificationData }[]> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    return shown.map((n) => ({ id: n.request.identifier, data: (n.request.content.data ?? {}) as NotificationData }));
  } catch {
    return [];
  }
}

/** The host's `closeReadNotifications`: a read covered the messages up to `lastReadTs`. */
export async function closeReadNotifications(tag: string, lastReadTs: number): Promise<void> {
  dismissBanner(tag);
  for (const { id, data } of await presented()) {
    if (data.tag !== tag) continue;
    // A message after the point read is still unread, so its notification stays.
    if ((data.ts ?? 0) <= lastReadTs) await Notifications.dismissNotificationAsync(id).catch(() => {});
  }
}

/** The host's `closeNotificationsReadElsewhere`: only channels in `stillUnread` keep theirs. */
export async function closeNotificationsReadElsewhere(stillUnread: Set<string>): Promise<void> {
  for (const { id, data } of await presented()) {
    const target = data.target;
    // Threads, forum posts and reminders are closed by their own reads.
    if (!target || target.threadId || target.postId || target.panel) continue;
    if (!stillUnread.has(channelNotificationTag(target.roomId, target.channelId ?? ""))) {
      await Notifications.dismissNotificationAsync(id).catch(() => {});
    }
  }
}

function open(response: Notifications.NotificationResponse | null) {
  const target = (response?.notification.request.content.data as NotificationData | undefined)?.target;
  if (!target?.roomId) return;
  Notifications.clearLastNotificationResponse();
  emit("notification-navigate", target);
}

/** A link that started the app, kept until there is something to open. */
let pendingLink: NotificationTarget | null = null;

/**
 * A `chatter://open?…` link (+native-intent.tsx): gone to now, or once the
 * conversations are loaded if it is what started the app.
 */
export function openLink(target: NotificationTarget, initial: boolean): void {
  if (initial) pendingLink = target;
  else emit("notification-navigate", target);
}

/**
 * Tapped notifications, opened as they come; and the notification or link
 * that started the app, if one did. Call once the conversations are loaded,
 * so the destination exists to go to. Returns the unsubscribe.
 */
export function listenForOpenedNotifications(): () => void {
  if (pendingLink) {
    const target = pendingLink;
    pendingLink = null;
    emit("notification-navigate", target);
  }
  open(Notifications.getLastNotificationResponse());
  const sub = Notifications.addNotificationResponseReceivedListener(open);
  return () => sub.remove();
}

/**
 * Ask for permission to notify, once, when it can still be asked. Android 13
 * and later need it; earlier versions have it already.
 */
export async function askToNotify(): Promise<void> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== "granted" && permission.canAskAgain) await Notifications.requestPermissionsAsync();
    await ensureChannel();
  } catch {
    // Asked another time.
  }
}
