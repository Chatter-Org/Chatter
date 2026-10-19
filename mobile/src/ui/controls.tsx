import type { ComponentType, ReactNode } from "react";
import { Pressable, Switch as NativeSwitch, View, type PressableProps } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import type { LucideProps } from "lucide-react-native";
import * as Recipe from "@chatter/core/ui/recipes";
import type { ThemeToken } from "@/theme/themes.generated";
import { Icon, T } from "./primitives";
import { cn } from "./cn";

/**
 * The web's shadcn controls, natively: the same recipes (@chatter/core/ui/
 * recipes) for colour, size and shape, with a pressed state where the web has
 * hover, and labels styled separately because React Native text inherits
 * nothing from its container.
 */

const PRESSED: Record<Recipe.ButtonVariant, string> = {
  default: "active:bg-primary/90",
  destructive: "active:bg-destructive/90",
  outline: "active:bg-accent",
  secondary: "active:bg-secondary/80",
  ghost: "active:bg-accent",
  link: "active:opacity-70",
};

/** The colour of a button's icon, matching its label. */
const ICON_TONE: Record<Recipe.ButtonVariant, ThemeToken | "white"> = {
  default: "primary-foreground",
  destructive: "white",
  outline: "foreground",
  secondary: "secondary-foreground",
  ghost: "foreground",
  link: "primary",
};

export function Button({
  variant = "default",
  size = "default",
  icon,
  iconTone,
  children,
  className,
  textClassName,
  disabled,
  ...props
}: Omit<PressableProps, "children"> & {
  variant?: Recipe.ButtonVariant;
  size?: Recipe.ButtonSize;
  icon?: ComponentType<LucideProps>;
  /** The icon's colour, when the label's is overridden too. */
  iconTone?: ThemeToken;
  children?: ReactNode;
  className?: string;
  textClassName?: string;
}) {
  const v = Recipe.button.variant[variant];
  const s = Recipe.button.size[size];
  const tone = iconTone ?? ICON_TONE[variant];
  const iconSize = size === "xs" || size === "icon-xs" ? 12 : 16;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...props}
      className={cn(
        "flex-row items-center justify-center gap-2",
        Recipe.button.base.box,
        v.box,
        s.box,
        PRESSED[variant],
        // A phone's smallest comfortable target, whatever the web's size.
        size.startsWith("icon") ? "min-h-9 min-w-9" : "min-h-9",
        disabled && "opacity-50",
        className,
      )}
    >
      {icon ? <Icon as={icon} size={iconSize} {...(tone === "white" ? { color: "#fff" } : { tone })} /> : null}
      {typeof children === "string" ? (
        <T className={cn(Recipe.button.base.text, v.text || "text-foreground", s.text, textClassName)}>{children}</T>
      ) : (
        children
      )}
    </Pressable>
  );
}

export function Badge({
  variant = "default",
  children,
  className,
}: {
  variant?: Recipe.BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  const v = Recipe.badge.variant[variant];
  return (
    <View className={cn("flex-row items-center justify-center self-start gap-1", Recipe.badge.base.box, v.box, className)}>
      {typeof children === "string" || typeof children === "number" ? (
        <T className={cn(Recipe.badge.base.text, v.text)}>{children}</T>
      ) : (
        children
      )}
    </View>
  );
}

/** A segmented switch — the sidebar's DMs / Rooms. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange(value: V): void;
  className?: string;
}) {
  return (
    <View className={cn("flex-row", Recipe.segmented.track.box, className)} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        const look = on ? Recipe.segmented.on : Recipe.segmented.off;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            className={cn("flex-1 items-center justify-center", Recipe.segmented.item.box, look.box)}
          >
            <T className={cn(Recipe.segmented.item.text, "font-medium", look.text)}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A card: the web's panels and boxes. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <View className={cn(Recipe.card.box, className)}>{children}</View>;
}

/**
 * The web's Switch: the primary track when on, the input colour when off,
 * and a thumb that stays visible on a dark theme (foreground off,
 * primary-foreground on) — the platform switch, in those colours.
 */
export function Switch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { mode, colors } = useTheme();
  const dark = mode !== "light";
  return (
    <NativeSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      trackColor={{ false: colors.input, true: colors.primary }}
      thumbColor={dark ? (value ? colors["primary-foreground"] : colors.foreground) : colors.background}
      style={disabled ? { opacity: 0.5 } : undefined}
    />
  );
}
