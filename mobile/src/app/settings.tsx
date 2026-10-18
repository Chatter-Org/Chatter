import { Alert, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { currentServer } from "@/platform/server";
import { SYSTEM_THEME, useTheme } from "@/theme/ThemeProvider";
import { THEME_COLORS, type ThemeColors } from "@/theme/themes.generated";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING, UI_META } from "@/ui/roles";

/**
 * Settings: who you are, how Chatter looks, and signing this device out.
 * Built from the web's pieces — the sidebar's account card, the Appearance
 * dialog's theme tiles — on a screen of its own, as a phone does settings.
 */
export default function Settings() {
  const state = useChatter();
  const { signOut } = useChatterActions();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = state.userId ? state.userPresence[state.userId] : undefined;
  const name = me?.displayName || (state.userId ? displayUserId(state.userId) : "");
  const system = THEME_COLORS[theme.mode === "light" ? "light" : "dark"];

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={ChevronLeft} size={24} />
        </Pressable>
        <T className="px-1 text-sm font-semibold">Settings</T>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-6 p-4">
        {/* The sidebar's account card; your profile is behind it. */}
        <Pressable
          onPress={() => router.push("/profile")}
          accessibilityRole="button"
          accessibilityHint="Edit your profile"
          className="flex-row items-center gap-3 rounded-lg border border-border bg-sidebar p-4 active:bg-sidebar-accent"
        >
          <Avatar
            userId={state.userId ?? undefined}
            name={name}
            url={me?.avatarUrl}
            size={40}
            status={me?.status ?? "online"}
            ring="sidebar"
            fallbackClassName="bg-primary"
            textClassName="text-sm font-bold text-primary-foreground"
          />
          <View className="min-w-0 flex-1">
            <T className="text-sm font-semibold" numberOfLines={1}>
              {name}
            </T>
            <T className={UI_META} numberOfLines={1}>
              {currentServer().replace(/^https?:\/\//, "")}
            </T>
          </View>
          <Icon as={ChevronRight} size={18} />
        </Pressable>

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
              <ThemeTile
                key={t.id}
                name={t.name}
                colors={THEME_COLORS[t.id]}
                selected={theme.preference === t.id}
                onPress={() => theme.setPreference(t.id)}
              />
            ))}
          </View>
        </View>

        <View className="gap-3">
          <T className={UI_HEADING}>Account</T>
          <Button
            variant="outline"
            icon={LogOut}
            iconTone="destructive"
            textClassName="text-destructive"
            className="self-start"
            onPress={() =>
              Alert.alert("Sign out of this device?", "You'll stay signed in on your other devices.", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign out", style: "destructive", onPress: () => void signOut() },
              ])
            }
          >
            Sign out of this device
          </Button>
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
}: {
  name: string;
  hint?: string;
  colors: ThemeColors;
  selected: boolean;
  onPress(): void;
}) {
  // The four the web's tiles show: background, card, accent, primary.
  const dots = [colors.background, colors.card, colors.accent, colors.primary];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={name}
      className={cn("w-[48.5%] rounded-lg border-2 p-3", selected ? "border-primary" : "border-muted-foreground/20 active:border-muted-foreground/40")}
      style={{ backgroundColor: colors.background }}
    >
      <T className="text-sm font-medium" style={{ color: colors.primary }} numberOfLines={1}>
        {name}
      </T>
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
