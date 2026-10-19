import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/** What another app shared into Chatter: text, files (copied into the cache), or both. */
export interface IncomingShare {
  text: string | null;
  subject: string | null;
  files: { uri: string; name: string; type: string | null; size: number }[];
  /** Shared files that could not be read. */
  failed: number;
}

interface ChatterShareNative {
  hasShare(): boolean;
  takeShareAsync(): Promise<IncomingShare | null>;
  addListener(event: "onShare", listener: () => void): EventSubscription;
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<ChatterShareNative>("ChatterShare") : null;

/** Whether a share is waiting to be taken. */
export function hasShare(): boolean {
  return native?.hasShare() ?? false;
}

/** The waiting share, taken: it will not be handed out again. */
export async function takeShare(): Promise<IncomingShare | null> {
  return (await native?.takeShareAsync()) ?? null;
}

/** Called when a share arrives while the app runs. Returns the unsubscribe. */
export function onShare(listener: () => void): () => void {
  const sub = native?.addListener("onShare", listener);
  return () => sub?.remove();
}
