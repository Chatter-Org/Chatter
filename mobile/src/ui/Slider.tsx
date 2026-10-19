import { useState } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture, useTapGesture, useCompetingGestures } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { cn } from "./cn";

/**
 * The web's Slider (shadcn): a track, the filled part in the primary colour,
 * and a round thumb — dragged or tapped anywhere along it. `onCommit` fires
 * once when the finger lifts, for whatever should not run on every step (a
 * test sound, a save).
 */
export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  onCommit,
  disabled,
  accessibilityLabel,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
  onCommit?(value: number): void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const [width, setWidth] = useState(0);
  const fraction = max > min ? (value - min) / (max - min) : 0;

  const at = (x: number) => {
    const f = Math.min(1, Math.max(0, width > 0 ? x / width : 0));
    const raw = min + f * (max - min);
    return Math.min(max, Math.max(min, Math.round(raw / step) * step));
  };
  const move = (x: number) => onChange(at(x));
  const end = (x: number) => onCommit?.(at(x));

  const pan = usePanGesture({
    enabled: !disabled,
    activeOffsetX: [-4, 4],
    onUpdate: (e) => {
      "worklet";
      scheduleOnRN(move, e.x);
    },
    onDeactivate: (e) => {
      "worklet";
      scheduleOnRN(end, e.x);
    },
  });
  const tap = useTapGesture({
    enabled: !disabled,
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(move, e.x);
      scheduleOnRN(end, e.x);
    },
  });
  const gesture = useCompetingGestures(pan, tap);

  const nudge = (dir: 1 | -1) => {
    const next = Math.min(max, Math.max(min, value + dir * step * Math.max(1, Math.round((max - min) / step / 20))));
    onChange(next);
    onCommit?.(next);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        className={cn("h-8 justify-center", disabled && "opacity-50")}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min, max, now: Math.round(value * 100) / 100 }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
      >
        <View className="h-1.5 overflow-hidden rounded-full bg-muted">
          <View className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
        </View>
        <View
          pointerEvents="none"
          className="absolute size-4 rounded-full border border-primary bg-background"
          style={{ left: Math.max(0, fraction * width - 8) }}
        />
      </View>
    </GestureDetector>
  );
}
