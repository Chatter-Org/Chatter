import { AppState } from "react-native";
import type { Host } from "@chatter/core/platform";
import { emit } from "./events";
import { currentServer } from "./server";
import { showToast } from "./toast";
import { deferArrivalSound, dropDeferredArrivalSound } from "@chatter/core/soundRules";
import { playDeferredArrivalSound, playSound, playSoundUrl } from "./sounds";
import { adoptGifFavorites } from "@chatter/core/gifFavorites";
import type { GifFavoritesPayload } from "@chatter/core/api";
import { closeNotificationsReadElsewhere, closeReadNotifications, notify } from "./notifications";

/**
 * The phone's side of the shared core's host contract
 * (packages/core/src/platform.ts). Installed by install.ts.
 *
 * Pieces that need a native module of their own (saving files) start inert
 * here and are filled in as those land; the core treats an inert host as
 * "nothing shown, nothing played", which is safe.
 */
export const nativeHost: Partial<Host> = {
  origin: currentServer,
  // The app in the foreground is the phone's equivalent of a focused tab.
  hasFocus: () => AppState.currentState === "active",
  emit,
  toast: (message, options) => showToast({ message, description: options?.description }),
  toastError: (message) => showToast({ message, tone: "error" }),
  notify,
  closeReadNotifications,
  closeNotificationsReadElsewhere,
  playSound,
  playSoundUrl,
  deferArrivalSound,
  playDeferredArrivalSound,
  dropDeferredArrivalSound,
  prewarmSounds: () => {},
  adoptGifFavorites: (payload) => adoptGifFavorites(payload as GifFavoritesPayload),
};
