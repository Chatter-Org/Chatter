import { useState } from "react";
import { Pressable, ScrollView, Share, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Download, Pencil, Plus, Share2 } from "lucide-react-native";
import { themeShareLink } from "@chatter/core/themeShare";
import { currentServer } from "@/platform/server";
import { showToast } from "@/platform/toast";
import { SYSTEM_THEME, customThemeColors, useTheme } from "@/theme/ThemeProvider";
import { THEME_COLORS, type ThemeColors } from "@/theme/themes.generated";
import { Button, Switch } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { updateDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { UI_HEADING, UI_HINT } from "@/ui/roles";
import { Field, TextField } from "@/ui/settings";

/**
 * How Chatter looks — the web's Appearance dialog: the built-in themes, the
 * ones you made (synced with your account, so the web's are here too), and
 * making, importing and sharing one. Then how it feels to touch: the phone's
 * buzz, which is this device's own.
 */
export default function AppearanceSettings() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const system = THEME_COLORS[theme.mode === "light" ? "light" : "dark"];
  const activeCustom = theme.customThemes.find((t) => t.id === theme.preference);
  const prefs = useDevicePrefs();

  const doImport = () => {
    try {
      const t = theme.importTheme(importText);
      theme.setPreference(t.id);
      setImporting(false);
      setImportText("");
      showToast({ message: `Imported "${t.name}"` });
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "That is not a theme");
    }
  };

  const share = (id: string) => {
    const code = theme.shareCode(id);
    if (!code) return;
    void Share.share({ message: themeShareLink(code, currentServer()) }).catch(() => {});
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Appearance" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-6 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <View className="gap-3">
          <T className={UI_HEADING}>Theme</T>
          {/* The Appearance dialog's tiles: each drawn in its own colours. */}
          <View className="flex-row flex-wrap justify-between gap-y-3">
            <ThemeTile
              name="Match phone"
              hint={`Following ${theme.mode === "light" ? "Light" : "Default Dark"}`}
              colors={system}
              selected={theme.preference === SYSTEM_THEME}
              onPress={() => theme.setPreference(SYSTEM_THEME)}
            />
            {theme.themes.map((t) => (
              <ThemeTile key={t.id} name={t.name} colors={THEME_COLORS[t.id]} selected={theme.preference === t.id} onPress={() => theme.setPreference(t.id)} />
            ))}
          </View>
        </View>

        <View className="gap-3">
          <T className={UI_HEADING}>Your themes</T>
          {theme.customThemes.length === 0 ? (
            <T className={UI_HINT}>Themes you make here or on the web show up here, on every device you sign in on.</T>
          ) : (
            <View className="flex-row flex-wrap justify-between gap-y-3">
              {theme.customThemes.map((t) => (
                <ThemeTile
                  key={t.id}
                  name={t.name}
                  colors={customThemeColors(t)}
                  selected={theme.preference === t.id}
                  onPress={() => theme.setPreference(t.id)}
                  onEdit={() => router.push({ pathname: "/settings/theme-edit", params: { id: t.id } })}
                />
              ))}
            </View>
          )}
          <View className="flex-row flex-wrap gap-2">
            <Button variant="outline" size="sm" icon={Plus} onPress={() => router.push("/settings/theme-edit")}>
              Create Theme
            </Button>
            <Button variant="outline" size="sm" icon={Download} onPress={() => (setImporting((v) => !v), setImportError(""))}>
              Import Theme
            </Button>
            {activeCustom ? (
              <Button variant="outline" size="sm" icon={Share2} onPress={() => share(activeCustom.id)}>
                Share Current
              </Button>
            ) : null}
          </View>
          {importing ? (
            <Field label="Import" hint="A theme link, a share code (ct1_…), or theme JSON.">
              <TextField
                value={importText}
                onChangeText={(v) => (setImportText(v), setImportError(""))}
                placeholder="Paste it here"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              {importError ? <T className="text-xs text-destructive">{importError}</T> : null}
              <Button size="sm" className="self-start" disabled={!importText.trim()} onPress={doImport}>
                Import and apply
              </Button>
            </Field>
          ) : null}
        </View>

        <View className="gap-3">
          <T className={UI_HEADING}>Touch</T>
          <View className="flex-row items-center gap-3">
            <View className="flex-1 gap-0.5">
              <T className="text-sm">Haptic feedback</T>
              <T className={UI_HINT}>A short buzz when a swipe will reply, when you hold a message, and when push to talk goes live. Kept on this device.</T>
            </View>
            <Switch value={prefs.haptics} onValueChange={(haptics) => updateDevicePrefs({ haptics })} accessibilityLabel="Haptic feedback" />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function ThemeTile({
  name,
  hint,
  colors,
  selected,
  onPress,
  onEdit,
}: {
  name: string;
  hint?: string;
  colors: ThemeColors;
  selected: boolean;
  onPress(): void;
  onEdit?(): void;
}) {
  // The four the web's tiles show: background, card, accent, primary.
  const dots = [colors.background, colors.card, colors.accent, colors.primary];
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onEdit}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={name}
      className={cn("w-[48.5%] rounded-lg border-2 p-3", selected ? "border-primary" : "border-muted-foreground/20 active:border-muted-foreground/40")}
      style={{ backgroundColor: colors.background }}
    >
      <View className="flex-row items-center gap-1">
        <T className="flex-1 text-sm font-medium" style={{ color: colors.primary }} numberOfLines={1}>
          {name}
        </T>
        {onEdit ? (
          <Pressable onPress={onEdit} hitSlop={8} accessibilityLabel={`Edit ${name}`}>
            <Icon as={Pencil} size={13} color={colors.primary} />
          </Pressable>
        ) : null}
      </View>
      {hint ? (
        <T className="text-3xs" style={{ color: colors["muted-foreground"] }} numberOfLines={1}>
          {hint}
        </T>
      ) : null}
      <View className="mt-2 flex-row gap-1.5">
        {dots.map((c, i) => (
          <View key={i} className="h-4 w-4 rounded-full border border-white/10" style={{ backgroundColor: c }} />
        ))}
      </View>
    </Pressable>
  );
}
