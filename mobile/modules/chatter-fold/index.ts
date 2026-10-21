import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * A foldable's hinge, as it crosses the app's window (Jetpack WindowManager).
 * Android only; elsewhere, and on a phone without one, there are no folds.
 */
export interface Fold {
  /** Where the hinge is, in dp from the window's top left. A fold that does
   *  not hide anything is a line (zero width or height). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Flat, or bent partway — a laptop or a book. */
  state: "flat" | "halfOpened";
  /** A vertical hinge splits left from right; a horizontal one, top from bottom. */
  orientation: "vertical" | "horizontal";
  /** Whether the hinge divides the window into two areas worth laying out apart. */
  separating: boolean;
  /** Whether the hinge hides what is under it (a gap between two screens). */
  occluding: boolean;
}

interface ChatterFoldNative {
  getFolds(): Fold[];
  addListener(event: "onFoldsChanged", listener: (e: { folds: Fold[] }) => void): EventSubscription;
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<ChatterFoldNative>("ChatterFold") : null;

/** Whether this build has the native side (Android, rebuilt with it). */
export const foldsAvailable = !!native;

const NONE: Fold[] = [];
let folds: Fold[] | null = null;
const listeners = new Set<() => void>();
let subscription: EventSubscription | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (native && !subscription) {
    subscription = native.addListener("onFoldsChanged", (e) => {
      folds = e.folds;
      listeners.forEach((l) => l());
    });
    // The first report can land between the first read and subscribing.
    folds = native.getFolds();
    listeners.forEach((l) => l());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

function getSnapshot(): Fold[] {
  if (!native) return NONE;
  folds ??= native.getFolds();
  return folds;
}

/** The window's folds, kept current as the phone folds, unfolds or bends. */
export function useFolds(): Fold[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
