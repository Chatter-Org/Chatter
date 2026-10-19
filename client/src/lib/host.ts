/**
 * The browser's side of the shared core's host contract (see
 * `@chatter/core/platform`). Imported first thing in main.tsx, before anything
 * that might raise a toast or play a sound.
 */

import { toast } from "sonner";
import { configureHost } from "@chatter/core/platform";
import type { GifFavoritesPayload } from "@/lib/api";
import { adoptGifFavorites } from "@/hooks/useFavoriteGifs";
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
});

// Warm the derived leave sound now, so the first leave is not silent while it
// decodes. See lib/sounds.ts. (This used to run when the socket handler loaded.)
prewarmSounds();
