import { Alert, Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronLeft, LogOut } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { currentServer } from "@/platform/server";
import { SYSTEM_THEME, useTheme } from "@/theme/ThemeProvider";
import { THEME_COLORS } from "@/theme/themes.generated";
import { Avatar } from "@/components/Avatar";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";

/** The app's settings: account, appearance, and signing this device out. */
export default function Settings() {
  const state = useChatter();
  const { signOut } = useChatterActions();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = state.userId ? state.userPresence[state.userId] : undefined;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="h-14 flex-row items-center gap-1 border-b border-border px-1">
        <Pressable onPress={() => router.back()} accessibilityLabel="Back" className="h-11 w-11 items-center justify-center rounded-full active:bg-accent">
          <Icon as={ChevronLeft} tone="foreground" size={24} />
        </Pressable>
        <T className="font-mono-bold text-base">Settings</T>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-6 px-4 pt-4">
        <View className="flex-row items-center gap-3 rounded-xl bg-card p-4">
          <Avatar userId={state.userId ?? undefined} url={me?.avatarUrl} size={52} status={me?.status} />
          <View className="flex-1">
            <T className="font-mono-bold text-base">{me?.displayName || (state.userId ? displayUserId(state.userId) : "")}</T>
            <T className="text-xs text-muted-foreground">{currentServer().replace(/^https?:\/\//, "")}</T>
          </View>
        </View>

        <Section title="Appearance">
          <ThemeOption id={SYSTEM_THEME} name="Match phone" swatch={[THEME_COLORS.light.background, THEME_COLORS.dark.background]} selected={theme.preference === SYSTEM_THEME} onPress={() => theme.setPreference(SYSTEM_THEME)} />
          {theme.themes.map((t) => (
            <ThemeOption
              key={t.id}
              id={t.id}
              name={t.name}
              swatch={[THEME_COLORS[t.id].background, THEME_COLORS[t.id]["sidebar-primary"]]}
              selected={theme.preference === t.id}
              onPress={() => theme.setPreference(t.id)}
            />
          ))}
        </Section>

        <Section title="Account">
          <Pressable
            onPress={() =>
              Alert.alert("Sign out of this device?", "You'll stay signed in on your other devices.", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign out", style: "destructive", onPress: () => void signOut() },
              ])
            }
            accessibilityRole="button"
            className="flex-row items-center gap-3 px-4 py-3.5 active:bg-accent"
          >
            <Icon as={LogOut} tone="destructive" />
            <T className="text-destructive">Sign out of this device</T>
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <T className="px-1 text-[11px] uppercase tracking-widest text-muted-foreground">{title}</T>
      <View className="overflow-hidden rounded-xl bg-card">{children}</View>
    </View>
  );
}

function ThemeOption({ name, swatch, selected, onPress }: { id: string; name: string; swatch: string[]; selected: boolean; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ checked: selected }} className={cn("flex-row items-center gap-3 border-b border-border px-4 py-3", "active:bg-accent")}>
      <View className="h-7 w-7 flex-row overflow-hidden rounded-full border border-border">
        {swatch.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: c }} />
        ))}
      </View>
      <T className="flex-1">{name}</T>
      {selected && <Icon as={Check} tone="foreground" />}
    </Pressable>
  );
}
