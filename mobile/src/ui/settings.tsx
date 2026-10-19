import type { ReactNode } from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import * as Recipe from "@chatter/core/ui/recipes";
import { useTheme } from "@/theme/ThemeProvider";
import { T } from "./primitives";
import { cn } from "./cn";
import { UI_HINT } from "./roles";

/**
 * The web's settings dialogs' parts (UserProfileDialog's SettingsSection and
 * Field): a titled card for a group of settings, and one control in it with
 * its name and its note.
 */

export function SettingsSection({
  title,
  hint,
  tone,
  children,
}: {
  title: string;
  hint?: string;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <View className={cn("gap-3 rounded-lg border p-3.5", tone === "danger" ? "border-destructive/30 bg-destructive/5" : "border-border/50 bg-muted/20")}>
      <View className="gap-0.5">
        <T className={cn("text-sm font-semibold", tone === "danger" && "text-destructive")}>{title}</T>
        {hint ? <T className={UI_HINT}>{hint}</T> : null}
      </View>
      {children}
    </View>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <T className="text-xs font-medium text-foreground">{label}</T>
      {children}
      {typeof hint === "string" ? <T className={UI_HINT}>{hint}</T> : hint}
    </View>
  );
}

/** The web's Input (and, multiline, its Textarea). */
export function TextField({ className, multiline, ...props }: TextInputProps & { className?: string }) {
  const { colors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors["muted-foreground"]}
      multiline={multiline}
      textAlignVertical={multiline ? "top" : "center"}
      {...props}
      className={cn(
        Recipe.input.box,
        "font-mono text-sm text-foreground",
        multiline && "h-auto min-h-20 py-2",
        className,
      )}
    />
  );
}
