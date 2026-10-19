import { notificationTargetFromQuery } from "@chatter/core/notifications";
import { openLink } from "@/platform/notifications";

/**
 * Links into the app: `chatter://open?room=…&channel=…&thread=…&post=…&panel=…`,
 * the destination a push opens the web app with (sw.js), so a notification or
 * a link from elsewhere lands on the conversation. They go through the same
 * `notification-navigate` path as a tapped notification and leave the routes
 * alone; anything else passes through untouched.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    const match = /(?:^|:\/\/|\/)open\/?\?(.*)$/.exec(path);
    if (!match) return path;
    const target = notificationTargetFromQuery(new URLSearchParams(match[1]));
    if (!target) return initial ? "/" : null;
    openLink(target, initial);
    return initial ? "/" : null;
  } catch {
    return initial ? "/" : null;
  }
}
