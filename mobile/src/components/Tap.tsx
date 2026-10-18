import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { GestureDetector, useTapGesture } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { cn } from "@/ui/cn";

/**
 * Something tappable inside a message. The row's own gestures (swipe to
 * reply, hold for actions) take the touch before a React Native Pressable
 * would see it, so a control here is a tap gesture of its own, which wins
 * over them the moment the finger lifts without moving.
 */
export function Tap({
  onPress,
  label,
  className,
  disabled,
  selected,
  children,
}: {
  onPress(): void;
  label: string;
  className?: string;
  disabled?: boolean;
  /** Pressed-in, for a control that toggles (a poll answer). */
  selected?: boolean;
  children: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const tap = useTapGesture({
    enabled: !disabled,
    onBegin: () => {
      "worklet";
      scheduleOnRN(setPressed, true);
    },
    onActivate: () => {
      "worklet";
      scheduleOnRN(onPress);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(setPressed, false);
    },
  });
  return (
    <GestureDetector gesture={tap}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled, selected }}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={onPress}
        className={cn(className, pressed && "bg-accent")}
      >
        {children}
      </View>
    </GestureDetector>
  );
}
