import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { dismissToast, subscribeToasts, type Toast } from "@/platform/toast";

/** Draws the toasts raised through host.toast (platform/toast.ts), top of screen. */
export function ToastHost() {
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12 }}>
      {toasts.map((toast) => (
        <Animated.View key={toast.id} entering={FadeInUp} exiting={FadeOutUp} className="mb-2">
          <Pressable
            onPress={() => dismissToast(toast.id)}
            accessibilityRole="alert"
            className={cn(
              "rounded-lg border px-4 py-3 bg-popover border-border",
              toast.tone === "error" && "border-destructive",
            )}
          >
            <T className={cn(toast.tone === "error" && "text-destructive")}>{toast.message}</T>
            {toast.description ? <T className="mt-0.5 text-xs text-muted-foreground">{toast.description}</T> : null}
          </Pressable>
        </Animated.View>
      ))}
    </View>
  );
}
