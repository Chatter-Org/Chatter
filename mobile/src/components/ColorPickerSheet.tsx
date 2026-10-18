import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Check } from "lucide-react-native";
import { isHexColor, isDarkColor } from "@chatter/core/color";
import { Sheet } from "@/ui/Sheet";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { TextField } from "@/ui/settings";
import { cn } from "@/ui/cn";

/** HSL (degrees, 0–1, 0–1) as `#rrggbb`. */
function hsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

const HUES = [0, 20, 40, 60, 90, 140, 170, 195, 215, 240, 265, 290, 320, 345];
const LIGHTNESS = [0.85, 0.7, 0.55, 0.42, 0.3, 0.18];
/** Greys from near-black to white, and the neutrals themes are built on. */
const GREYS = ["#0a0a0a", "#171717", "#262626", "#363636", "#525252", "#737373", "#a3a3a3", "#d4d4d4", "#e8e8e8", "#fafafa"];

/**
 * Choosing a colour where the web has `<input type="color">`: a palette of
 * hues at a range of lightness, the greys themes are made of, and the exact
 * hex for when you know it.
 */
export function ColorPickerSheet({
  open,
  title,
  value,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  value: string;
  onClose(): void;
  onPick(hex: string): void;
}) {
  const [hex, setHex] = useState(value);
  useEffect(() => {
    if (open) setHex(value);
  }, [open, value]);
  const rows = useMemo(() => LIGHTNESS.map((l) => HUES.map((h) => hsl(h, l > 0.8 || l < 0.25 ? 0.55 : 0.7, l))), []);
  const typed = hex.startsWith("#") ? hex : `#${hex}`;
  const valid = isHexColor(typed);

  const swatch = (c: string) => {
    const on = c.toLowerCase() === value.toLowerCase();
    return (
      <Pressable
        key={c}
        onPress={() => onPick(c)}
        accessibilityRole="button"
        accessibilityLabel={c}
        className="aspect-square flex-1 items-center justify-center rounded-md border border-white/10"
        style={{ backgroundColor: c }}
      >
        {on ? <Icon as={Check} size={12} color={isDarkColor(c) ? "#fff" : "#000"} /> : null}
      </Pressable>
    );
  };

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View className="gap-1 px-4 pb-2 pt-1">
        {rows.map((row, i) => (
          <View key={i} className="flex-row gap-1">
            {row.map(swatch)}
          </View>
        ))}
        <View className="mt-1 flex-row gap-1">{GREYS.map(swatch)}</View>
        <View className="mt-3 flex-row items-center gap-2">
          <View className={cn("size-9 rounded-md border border-border")} style={{ backgroundColor: valid ? typed : "transparent" }} />
          <TextField
            className="flex-1"
            value={hex}
            onChangeText={setHex}
            placeholder="#rrggbb"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={7}
          />
          <Button size="sm" disabled={!valid} onPress={() => onPick(typed.toLowerCase())}>
            Use
          </Button>
        </View>
        {!valid && hex.length >= 6 ? <T className="text-xs text-destructive">That is not a colour — six hex digits, like #3b82f6.</T> : null}
      </View>
    </Sheet>
  );
}
