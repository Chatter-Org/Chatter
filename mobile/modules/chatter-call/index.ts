import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * The call's native side: a foreground service that keeps a call running
 * with the app out of sight (and its notification, with Mute and Leave), and
 * the choice between speaker, earpiece and headsets. Android only; elsewhere
 * every call here does nothing.
 */

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
  addListener(event: "onCallAction", listener: (e: { action: "leave" | "toggleMute" }) => void): EventSubscription;
  addListener(event: "onAudioRoutesChanged", listener: (e: { routes: AudioRoute[] }) => void): EventSubscription;
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<ChatterCallNative>("ChatterCall") : null;

export const callService = {
  available: !!native,
  start: (title: string, text: string, muted: boolean) => native?.startCall(title, text, muted),
  update: (title: string, text: string, muted: boolean) => native?.updateCall(title, text, muted),
  stop: () => native?.stopCall(),
  routes: (): AudioRoute[] => native?.getAudioRoutes() ?? [],
  setRoute: (id: AudioRoute["id"]) => native?.setAudioRoute(id),
  onAction(listener: (action: "leave" | "toggleMute") => void): () => void {
    const sub = native?.addListener("onCallAction", (e) => listener(e.action));
    return () => sub?.remove();
  },
  onRoutesChanged(listener: (routes: AudioRoute[]) => void): () => void {
    const sub = native?.addListener("onAudioRoutesChanged", (e) => listener(e.routes));
    return () => sub?.remove();
  },
};
