import type { ComponentProps, ComponentType } from "react";
import { Text } from "react-native";
import type { LucideProps } from "lucide-react-native";
import { textClasses } from "./cn";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemeToken } from "@/theme/themes.generated";

/**
 * Text in Chatter's face. Every string on screen goes through this, so the
 * font and colour are right by default and a className only says what differs.
 * Web weights (`font-medium`, `font-bold`) work as on the web; see textClasses.
 */
export function T({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text {...props} className={textClasses("font-mono text-sm text-foreground", className)} />;
}

/**
 * A Lucide icon — the same set the web client uses — coloured by theme token.
 */
export function Icon({
  as: Glyph,
  tone = "muted-foreground",
  color,
  size = 18,
  strokeWidth = 2,
}: {
  as: ComponentType<LucideProps>;
  tone?: ThemeToken;
  /** An explicit colour wins over the tone. */
  color?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const { colors } = useTheme();
  return <Glyph size={size} color={color ?? colors[tone]} strokeWidth={strokeWidth} />;
}
