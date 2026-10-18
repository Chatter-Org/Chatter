import { memo } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { displayUserId } from "@chatter/core/utils";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemeToken } from "@/theme/themes.generated";

// The web's presence colours (AppSidebar / MembersPanel).
const STATUS_TONE: Record<string, ThemeToken> = {
  online: "success",
  active: "success",
  idle: "warning",
  away: "warning",
  dnd: "destructive",
};

/**
 * Someone's picture, or their initial — the web's Avatar: a circle, with the
 * fallback in `bg-secondary` (messages, members) unless a place asks for
 * another (the sidebar's own account uses the primary colour). A presence dot
 * sits on the corner when given, ringed in the surface it is drawn on.
 */
export const Avatar = memo(function Avatar({
  userId,
  name,
  url,
  size = 36,
  status,
  ring = "background",
  fallbackClassName,
  textClassName,
  className,
}: {
  userId?: string;
  name?: string;
  url?: string | null;
  size?: number;
  status?: string;
  /** The colour around the presence dot: the surface underneath. */
  ring?: ThemeToken;
  fallbackClassName?: string;
  textClassName?: string;
  className?: string;
}) {
  const { colors } = useTheme();
  const label = name || (userId ? displayUserId(userId) : "?");
  const source = serverImage(url);
  // h-2.5 on a 36px avatar, h-3 on the sidebar's 40px one.
  const dot = Math.max(10, Math.round(size * 0.3));
  const tone = status ? (STATUS_TONE[status] ?? "muted-foreground") : undefined;

  return (
    <View style={{ width: size, height: size }} className={className}>
      {source ? (
        <Image
          source={source}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.muted }}
          contentFit="cover"
          transition={120}
          recyclingKey={source.uri}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View
          style={{ width: size, height: size, borderRadius: size / 2 }}
          className={cn("items-center justify-center bg-secondary", fallbackClassName)}
        >
          <T className={cn("font-semibold text-secondary-foreground", size >= 36 ? "text-xs" : "text-3xs", textClassName)}>
            {label.slice(0, 1).toUpperCase()}
          </T>
        </View>
      )}
      {tone && (
        <View
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            borderWidth: 2,
            borderColor: colors[ring],
            backgroundColor: colors[tone],
          }}
        />
      )}
    </View>
  );
});
