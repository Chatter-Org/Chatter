import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { Icon, T } from "./primitives";
import { UI_META } from "./roles";

/**
 * A pushed screen's title bar: back, the title (and a line under it), and
 * whatever the screen puts on the right. The same bar every settings screen
 * and sheet-like screen uses.
 */
export function ScreenHeader({ title, subtitle, right, onBack }: { title: string; subtitle?: string; right?: ReactNode; onBack?(): void }) {
  return (
    <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
      <Pressable
        onPress={onBack ?? (() => router.back())}
        accessibilityRole="button"
        accessibilityLabel="Back"
        className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
      >
        <Icon as={ChevronLeft} size={24} />
      </Pressable>
      <View className="min-w-0 flex-1 px-1">
        <T className="text-sm font-semibold" numberOfLines={1}>
          {title}
        </T>
        {subtitle ? (
          <T className={UI_META} numberOfLines={1}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right}
    </View>
  );
}
