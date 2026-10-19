import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, Trash2 } from "lucide-react-native";
import { isDarkColor } from "@chatter/core/color";
import {
  DEFAULT_BORDER_STRENGTH,
  MIN_TEXT_CONTRAST,
  checkContrast,
  type ThemeAdvanced,
  type ThemeColors as BaseColors,
  type ThemeMode,
} from "@chatter/core/theme";
import { ColorPickerSheet } from "@/components/ColorPickerSheet";
import { customThemeColors, useTheme } from "@/theme/ThemeProvider";
import { Button, Segmented } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Slider } from "@/ui/Slider";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HINT } from "@/ui/roles";
import { Field, SettingsSection, TextField } from "@/ui/settings";

const BASE_FIELDS: [keyof BaseColors, string][] = [
  ["background", "Background"],
  ["card", "Card"],
  ["accent", "Accent"],
  ["primary", "Primary"],
];

type Picking = { kind: "base"; key: keyof BaseColors } | { kind: "advanced"; key: "sidebar" | "mention" } | null;

/**
 * Making or editing a custom theme (`?id=`) — the web's theme editor: a name,
 * the four colours everything else is derived from, the base palette, the
 * derived colours you may override, the contrast check, and a live preview.
 */
export default function ThemeEditor() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const editing = theme.customThemes.find((t) => t.id === id);

  const [name, setName] = useState(editing?.name ?? "");
  const [colors, setColors] = useState<BaseColors>(
    () =>
      editing?.colors ?? {
        // A new theme starts from the one on screen.
        background: theme.colors.background,
        card: theme.colors.card,
        accent: theme.colors.accent,
        primary: theme.colors.primary,
      },
  );
  const [mode, setMode] = useState<ThemeMode | null>(editing?.mode ?? null);
  const [advanced, setAdvanced] = useState<ThemeAdvanced>(editing?.advanced ?? {});
  const [advancedOpen, setAdvancedOpen] = useState(!!editing?.advanced);
  const [picking, setPicking] = useState<Picking>(null);

  // Follows the background until a mode is picked (the web's rule).
  const effectiveMode: ThemeMode = mode ?? (isDarkColor(colors.background) ? "dark" : "light");
  const draft = useMemo(
    () => ({ id: "draft", name, mode: effectiveMode, colors, advanced }),
    [name, effectiveMode, colors, advanced],
  );
  const preview = useMemo(() => customThemeColors(draft), [draft]);
  const contrast = checkContrast(colors);
  const failing = contrast.filter((c) => !c.passes);
  const saved = (): ThemeAdvanced | undefined => (Object.keys(advanced).length > 0 ? advanced : undefined);

  const save = () => {
    if (editing) {
      theme.updateCustomTheme(editing.id, name, colors, effectiveMode, saved());
    } else {
      const t = theme.addCustomTheme(name, colors, effectiveMode, saved());
      theme.setPreference(t.id);
    }
    router.back();
  };

  const pickValue = picking?.kind === "base" ? colors[picking.key] : picking ? (advanced[picking.key] ?? preview[picking.key]) : "#000000";

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader
        title={editing ? "Edit Theme" : "New Theme"}
        right={
          <Button size="sm" disabled={!name.trim()} onPress={save} className="mr-1">
            {editing ? "Update Theme" : "Create & Apply"}
          </Button>
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-4 p-4" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {/* A small piece of the app in the theme being made. */}
        <View className="overflow-hidden rounded-lg border" style={{ backgroundColor: preview.background, borderColor: preview.border }}>
          <View className="flex-row">
            <View className="w-20 gap-1.5 p-2" style={{ backgroundColor: preview.sidebar }}>
              {["general", "random", "voice"].map((c, i) => (
                <View key={c} className="rounded px-1.5 py-1" style={i === 0 ? { backgroundColor: preview["sidebar-accent"] } : undefined}>
                  <T className="text-3xs" style={{ color: i === 0 ? preview["sidebar-foreground"] : preview["muted-foreground"] }} numberOfLines={1}>
                    # {c}
                  </T>
                </View>
              ))}
            </View>
            <View className="flex-1 gap-2 p-3">
              <T className="text-sm font-medium" style={{ color: preview.foreground }}>
                {name || "Preview"}
              </T>
              <View className="rounded-md p-2" style={{ backgroundColor: preview.card }}>
                <T className="text-xs" style={{ color: preview["card-foreground"] }}>
                  A message on a card.
                </T>
                <T className="text-3xs" style={{ color: preview["muted-foreground"] }}>
                  12:08 PM · muted text
                </T>
              </View>
              <View className="rounded-md px-2 py-1" style={{ backgroundColor: `${preview.mention}22`, borderLeftWidth: 2, borderLeftColor: preview.mention }}>
                <T className="text-xs" style={{ color: preview.foreground }}>
                  @you were mentioned
                </T>
              </View>
              <View className="flex-row gap-2">
                <View className="rounded-md px-2.5 py-1" style={{ backgroundColor: preview.primary }}>
                  <T className="text-xs font-medium" style={{ color: preview["primary-foreground"] }}>
                    Button
                  </T>
                </View>
                <View className="rounded-md border px-2.5 py-1" style={{ borderColor: preview.input }}>
                  <T className="text-xs" style={{ color: preview.foreground }}>
                    Outline
                  </T>
                </View>
              </View>
            </View>
          </View>
        </View>

        <Field label="Name">
          <TextField value={name} onChangeText={setName} placeholder="Theme name" maxLength={60} />
        </Field>

        <SettingsSection title="Colours" hint="Everything else is worked out from these four.">
          <View className="flex-row flex-wrap gap-2">
            {BASE_FIELDS.map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setPicking({ kind: "base", key })}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${colors[key]}`}
                className="w-[48%] flex-row items-center gap-2 rounded-md border border-input p-2 active:bg-accent/50"
              >
                <View className="size-7 rounded border border-white/10" style={{ backgroundColor: colors[key] }} />
                <View>
                  <T className="text-xs">{label}</T>
                  <T className="text-3xs text-muted-foreground">{colors[key]}</T>
                </View>
              </Pressable>
            ))}
          </View>
        </SettingsSection>

        <SettingsSection title="Base palette" hint="Decides the colours a theme does not name for itself — error, success, warning. Follows the background until you pick.">
          <Segmented
            value={effectiveMode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(m) => setMode(m)}
          />
        </SettingsSection>

        <View className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
          <Pressable onPress={() => setAdvancedOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: advancedOpen }} className="flex-row items-center gap-2 p-3.5">
            <T className="flex-1 text-sm font-semibold">Derived colours</T>
            <T className={UI_HINT}>{Object.keys(advanced).length > 0 ? `${Object.keys(advanced).length} overridden` : "All derived"}</T>
            <View style={advancedOpen ? { transform: [{ rotate: "180deg" }] } : undefined}>
              <Icon as={ChevronDown} size={14} />
            </View>
          </Pressable>
          {advancedOpen ? (
            <View className="gap-3 border-t border-border/50 p-3.5">
              {(
                [
                  ["sidebar", "Sidebar"],
                  ["mention", "Mention highlight"],
                ] as const
              ).map(([key, label]) => {
                const overridden = advanced[key] !== undefined;
                return (
                  <View key={key} className="flex-row items-center gap-2">
                    <T className="flex-1 text-xs text-muted-foreground">{label}</T>
                    <Pressable
                      disabled={!overridden}
                      onPress={() => setPicking({ kind: "advanced", key })}
                      accessibilityLabel={`${label} colour`}
                      className={cn("size-7 rounded border border-white/10", !overridden && "opacity-40")}
                      style={{ backgroundColor: advanced[key] ?? preview[key] }}
                    />
                    <Button
                      variant="outline"
                      size="xs"
                      onPress={() =>
                        setAdvanced((prev) => {
                          const next = { ...prev };
                          if (overridden) delete next[key];
                          else next[key] = preview[key].startsWith("#") ? preview[key].slice(0, 7) : "#888888";
                          return next;
                        })
                      }
                    >
                      {overridden ? "Derive" : "Override"}
                    </Button>
                  </View>
                );
              })}
              <View className="gap-1">
                <View className="flex-row items-center justify-between">
                  <T className="text-xs text-muted-foreground">Border strength</T>
                  <T className="text-2xs text-muted-foreground">{Math.round((advanced.borderStrength ?? DEFAULT_BORDER_STRENGTH) * 100)}%</T>
                </View>
                <Slider
                  value={advanced.borderStrength ?? DEFAULT_BORDER_STRENGTH}
                  min={0}
                  max={1}
                  step={0.05}
                  accessibilityLabel="Border strength"
                  onChange={(borderStrength) => setAdvanced((prev) => ({ ...prev, borderStrength }))}
                />
              </View>
            </View>
          ) : null}
        </View>

        <SettingsSection title="Contrast" hint={`${MIN_TEXT_CONTRAST}:1 needed`}>
          {contrast.map((c) => (
            <View key={c.label} className="flex-row items-center justify-between">
              <T className="text-xs text-muted-foreground">{c.label}</T>
              <T className={cn("text-xs", c.passes ? "text-success" : "font-medium text-warning")}>{c.ratio.toFixed(1)}:1</T>
            </View>
          ))}
          {failing.length > 0 ? (
            <T className={UI_HINT}>
              {failing.length === 1 ? `${failing[0].label.toLowerCase()} will be hard to read.` : "Some text will be hard to read."} Saving anyway is fine — this is a warning, not a limit.
            </T>
          ) : null}
        </SettingsSection>

        {editing ? (
          <Button
            variant="outline"
            icon={Trash2}
            iconTone="destructive"
            textClassName="text-destructive"
            className="self-start border-destructive/30"
            onPress={() =>
              Alert.alert(`Delete "${editing.name}"?`, "It goes from every device you sign in on.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => {
                    theme.deleteCustomTheme(editing.id);
                    router.back();
                  },
                },
              ])
            }
          >
            Delete theme
          </Button>
        ) : null}
      </ScrollView>

      <ColorPickerSheet
        open={!!picking}
        title={picking?.kind === "base" ? (BASE_FIELDS.find(([k]) => k === picking.key)?.[1] ?? "Colour") : picking?.key === "sidebar" ? "Sidebar" : "Mention highlight"}
        value={pickValue}
        onClose={() => setPicking(null)}
        onPick={(hex) => {
          if (picking?.kind === "base") setColors((c) => ({ ...c, [picking.key]: hex }));
          else if (picking) setAdvanced((a) => ({ ...a, [picking.key]: hex }));
          setPicking(null);
        }}
      />
    </View>
  );
}
