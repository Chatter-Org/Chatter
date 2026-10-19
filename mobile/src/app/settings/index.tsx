import type { ComponentType } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { router, type Href } from "expo-router";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, ChevronRight, Database, LogOut, Mic, Palette, Server, ShieldCheck, type LucideProps } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { currentServer } from "@/platform/server";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Icon, T } from "@/ui/primitives";
import { UI_HEADING, UI_HINT, UI_META } from "@/ui/roles";

/**
 * Settings: who you are, then a row per section — the web's settings dialogs
 * (Appearance, the profile dialog's Device and Account tabs, Voice Settings)
 * as a phone lays settings out, one screen each — and signing this device out,
 * or out and off this server.
 */
const SECTIONS: { href: Href; icon: ComponentType<LucideProps>; label: string; hint: string }[] = [
  { href: "/settings/appearance", icon: Palette, label: "Appearance", hint: "Themes, and your own" },
  { href: "/settings/notifications", icon: Bell, label: "Notifications", hint: "What each server tells you, and sounds" },
  { href: "/settings/voice", icon: Mic, label: "Voice", hint: "Push to talk, volume, mic test" },
  { href: "/settings/account", icon: ShieldCheck, label: "Account", hint: "Two-factor, password, sessions" },
  { href: "/settings/data", icon: Database, label: "Data and storage", hint: "Media, and what is kept on this device" },
];

export default function Settings() {
  const state = useChatter();
  const { signOut } = useChatterActions();
  const insets = useSafeAreaInsets();
  const me = state.userId ? state.userPresence[state.userId] : undefined;
  const name = me?.displayName || (state.userId ? displayUserId(state.userId) : "");

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Settings" />
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

        <View className="overflow-hidden rounded-lg border border-border">
          {SECTIONS.map((s, i) => (
            <Pressable
              key={s.label}
              onPress={() => router.push(s.href)}
              accessibilityRole="button"
              className={`flex-row items-center gap-3 px-4 py-3.5 active:bg-accent ${i > 0 ? "border-t border-border" : ""}`}
            >
              <Icon as={s.icon} size={18} tone="foreground" />
              <View className="min-w-0 flex-1">
                <T className="text-sm font-medium">{s.label}</T>
                <T className={UI_HINT} numberOfLines={1}>
                  {s.hint}
                </T>
              </View>
              <Icon as={ChevronRight} size={16} />
            </Pressable>
          ))}
        </View>

        <View className="gap-3">
          <T className={UI_HEADING}>This device</T>
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
          <Button
            variant="outline"
            icon={Server}
            className="self-start"
            onPress={() =>
              Alert.alert(
                "Change server?",
                "This signs you out of this device, and you'll enter the new server's address when you sign in.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Change server", style: "destructive", onPress: () => void signOut({ forgetServer: true }) },
                ],
              )
            }
          >
            Change server
          </Button>
          <T className={UI_HINT}>Chatter {Constants.expoConfig?.version ?? ""}</T>
        </View>
      </ScrollView>
    </View>
  );
}
