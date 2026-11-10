/**
 * The browser's side of the shared core's host contract (see
 * `@chatter/core/platform`). Imported first thing in main.tsx, before anything
 * that might raise a toast or play a sound.
 */

import { toast } from "sonner";
import { configureHost } from "@chatter/core/platform";
import type { GifFavoritesPayload } from "@/lib/api";
import { adoptGifFavorites } from "@/hooks/useFavoriteGifs";
import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";
import {
  closeNotificationsReadElsewhere,
  closeReadNotifications,
  showDesktopNotification,
} from "@/lib/notifications";
import {
  deferArrivalSound,
  dropDeferredArrivalSound,
  playDeferredArrivalSound,
  playSound,
  playSoundUrl,
  prewarmSounds,
} from "@/lib/sounds";

configureHost({
  origin: () => window.location.origin,
  hasFocus: () => typeof document !== "undefined" && document.hasFocus(),
  emit: (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail })),
  toast: (message, options) => toast(message, options),
  toastError: (message) => toast.error(message),
  notify: showDesktopNotification,
  closeReadNotifications,
  closeNotificationsReadElsewhere,
  playSound,
  playSoundUrl,
  deferArrivalSound,
  playDeferredArrivalSound,
  dropDeferredArrivalSound,
  prewarmSounds,
  adoptGifFavorites: (payload) => adoptGifFavorites(payload as GifFavoritesPayload),
  saveFile: (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  // The encryption seed. Kept per browser profile, and forgotten on sign-out
  // (e2e/session.ts), so the next person at a shared computer needs the
  // passphrase.
  secretGet: async (name) => {
    try {
      return localStorage.getItem(`chatter-secret:${name}`);
    } catch {
      return null;
    }
  },
  secretSet: async (name, value) => {
    try {
      localStorage.setItem(`chatter-secret:${name}`, value);
    } catch {}
  },
  secretDelete: async (name) => {
    try {
      localStorage.removeItem(`chatter-secret:${name}`);
    } catch {}
  },
  // Link previews in encrypted DMs are made by the sender's device. A browser
  // page cannot read another site's page, so only the desktop app makes them;
  // a browser sends none rather than ask the server, which would learn the link.
  fetchForPreview:
    hasDesktopFeature("link-preview@1") && desktop?.linkPreview
      ? async (url, kind) => {
          const res = await desktop!.linkPreview!.fetch(url, kind);
          return res ? { url: res.url, type: res.type, bytes: new Uint8Array(res.bytes) } : null;
        }
      : null,
});

// Decode the built-in effects (and derive the leave sound) now, so the first
// of each plays the moment its event lands. See lib/sounds.ts.
prewarmSounds();
