import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * The call's native side: a foreground service that keeps a call running
 * with the app out of sight (and its notification, with Mute and Leave), and
 * the choice between speaker, earpiece and headsets. Android only; elsewhere
 * every call here does nothing.
 */

/**
 * What the call is asked to do from outside the app: the notification's Mute
 * and Leave, and Android's phone system holding it for a phone call,
 * resuming it after, or ending it (a car's or a watch's hang-up).
 */
export type CallAction = "leave" | "toggleMute" | "hold" | "resume";

export interface AudioRoute {
  id: "speaker" | "earpiece" | "wired" | "bluetooth";
  label: string;
  active: boolean;
}

interface ChatterCallNative {
  startCall(title: string, text: string, muted: boolean): void;
  updateCall(title: string, text: string, muted: boolean): void;
  stopCall(): void;
  getAudioRoutes(): AudioRoute[];
  setAudioRoute(id: string): void;
  addListener(event: "onCallAction", listener: (e: { action: CallAction }) => void): EventSubscription;
  addListener(event: "onAudioRoutesChanged", listener: (e: { routes: AudioRoute[] }) => void): EventSubscription;
  addListener(event: "onPipChanged", listener: (e: { active: boolean }) => void): EventSubscription;
  setAutoPictureInPicture(enabled: boolean, width: number, height: number): void;
  enterPictureInPicture(width: number, height: number): boolean;
  isInPictureInPicture(): boolean;
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<ChatterCallNative>("ChatterCall") : null;

export const callService = {
  available: !!native,
  start: (title: string, text: string, muted: boolean) => native?.startCall(title, text, muted),
  update: (title: string, text: string, muted: boolean) => native?.updateCall(title, text, muted),
  stop: () => native?.stopCall(),
  routes: (): AudioRoute[] => native?.getAudioRoutes() ?? [],
  setRoute: (id: AudioRoute["id"]) => native?.setAudioRoute(id),
  onAction(listener: (action: CallAction) => void): () => void {
    const sub = native?.addListener("onCallAction", (e) => listener(e.action));
    return () => sub?.remove();
  },
  onRoutesChanged(listener: (routes: AudioRoute[]) => void): () => void {
    const sub = native?.addListener("onAudioRoutesChanged", (e) => listener(e.routes));
    return () => sub?.remove();
  },
};

/**
 * Picture-in-picture, for a stream being watched: the app's window shrinks to
 * float over whatever comes next. `auto` lets leaving the app do it
 * (Android 12 and later); `enter` does it now.
 */
export const pictureInPicture = {
  available: !!native,
  auto: (enabled: boolean, width = 16, height = 9) => native?.setAutoPictureInPicture(enabled, Math.round(width), Math.round(height)),
  enter: (width = 16, height = 9) => native?.enterPictureInPicture(Math.round(width), Math.round(height)) ?? false,
  active: () => native?.isInPictureInPicture() ?? false,
  onChange(listener: (active: boolean) => void): () => void {
    const sub = native?.addListener("onPipChanged", (e) => listener(e.active));
    return () => sub?.remove();
  },
};
