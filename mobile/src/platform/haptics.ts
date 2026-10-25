import * as Haptics from "expo-haptics";
import { getDevicePrefs } from "@/state/devicePrefs";

/**
 * The phone's buzz, kept for the moments a gesture has nothing else to say it
 * worked: a swipe passing the point where it will reply, a hold that opened
 * the message's actions, the talk button going live. Taps, sends and menus
 * stay quiet, as Discord's do. Off in Appearance, nothing buzzes at all.
 */
export function buzz(strength: "light" | "medium" = "light"): void {
  if (!getDevicePrefs().haptics) return;
  const style = strength === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light;
  void Haptics.impactAsync(style).catch(() => {});
}
