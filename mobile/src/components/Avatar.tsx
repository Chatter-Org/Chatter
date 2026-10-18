import { memo } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { displayUserId } from "@chatter/core/utils";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { useTheme } from "@/theme/ThemeProvider";

const STATUS_TONE = {
  online: "success",
  idle: "warning",
  dnd: "destructive",
} as const;

/**
 * Someone's picture, or their initial on a neutral circle as on the web, with
 * an optional presence dot.
 */
export const Avatar = memo(function Avatar({
  userId,
  name,
  url,
  size = 36,
  status,
  className,
}: {
  userId?: string;
  name?: string;
  url?: string | null;
  size?: number;
  status?: string;
  className?: string;
}) {
  const { colors } = useTheme();
  const label = name || (userId ? displayUserId(userId) : "?");
  const source = serverImage(url);
  const dot = Math.max(8, Math.round(size * 0.3));
  const tone = status ? STATUS_TONE[status as keyof typeof STATUS_TONE] : undefined;

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
          className="items-center justify-center bg-muted"
        >
          <T className={cn("text-muted-foreground", size >= 40 ? "text-base" : "text-xs")}>
            {label.slice(0, 1).toUpperCase()}
          </T>
        </View>
      )}
      {status && (
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            borderWidth: 2,
            borderColor: colors.sidebar,
            backgroundColor: tone ? colors[tone] : colors["muted-foreground"],
          }}
        />
      )}
    </View>
  );
});
