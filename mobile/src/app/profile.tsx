import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Camera, Check, ChevronLeft } from "lucide-react-native";
import { apiUploadFile } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { fromImagePicker } from "@/components/AttachSheet";
import { nativeUploadSource, type PickedFile } from "@/platform/uploads";
import { showToast } from "@/platform/toast";
import { useTheme } from "@/theme/ThemeProvider";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HINT } from "@/ui/roles";
import { Field, SettingsSection, TextField } from "@/ui/settings";

// UserProfileDialog's STATUS_OPTIONS.
const STATUS_OPTIONS = [
  { value: "online", label: "Online", dot: "bg-success" },
  { value: "away", label: "Away", dot: "bg-warning" },
  { value: "dnd", label: "Do Not Disturb", dot: "bg-destructive" },
  { value: "offline", label: "Invisible", dot: "bg-muted-foreground" },
] as const;

/** Which option a presence status is (the server says active and idle). */
function optionFor(status: string | undefined) {
  if (status === "active") return "online";
  if (status === "idle") return "away";
  return status ?? "online";
}

/**
 * Your own profile — the Profile tab of the web's UserProfileDialog: the
 * banner and picture (tap either to change it), your name, status and about,
 * and your availability. The text and pictures wait for Save, as on the web;
 * availability takes effect the moment it is picked.
 */
export default function EditProfile() {
  const state = useChatter();
  const { updateProfile, setManualStatus } = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const me = state.userId ? state.userPresence[state.userId] : undefined;
  const username = state.userId ? displayUserId(state.userId) : "";

  const [displayName, setDisplayName] = useState(me?.displayName ?? "");
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? "");
  const [about, setAbout] = useState(me?.about ?? "");
  const [avatar, setAvatar] = useState<PickedFile | null>(null);
  const [banner, setBanner] = useState<PickedFile | null>(null);
  const [saving, setSaving] = useState(false);

  const keyboard = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, keyboard.height.value + insets.bottom) }] }));

  const changed =
    displayName.trim() !== (me?.displayName ?? "") ||
    customStatus.trim() !== (me?.customStatus ?? "") ||
    about.trim() !== (me?.about ?? "") ||
    !!avatar ||
    !!banner;

  const pick = async (which: "avatar" | "banner") => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: which === "avatar" ? [1, 1] : [3, 1],
        quality: 0.9,
      });
      if (result.canceled) return;
      const [file] = fromImagePicker(result.assets);
      (which === "avatar" ? setAvatar : setBanner)(file);
    } catch (e) {
      showToast({ tone: "error", message: "Couldn't open your photos", description: e instanceof Error ? e.message : undefined });
    }
  };

  const reset = () => {
    setDisplayName(me?.displayName ?? "");
    setCustomStatus(me?.customStatus ?? "");
    setAbout(me?.about ?? "");
    setAvatar(null);
    setBanner(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const avatarUrl = avatar ? (await apiUploadFile(nativeUploadSource(avatar))).url : undefined;
      const bannerUrl = banner ? (await apiUploadFile(nativeUploadSource(banner))).url : undefined;
      updateProfile({
        avatarUrl,
        bannerUrl,
        about: about.trim(),
        customStatus: customStatus.trim(),
        displayName: displayName.trim(),
      });
      setAvatar(null);
      setBanner(null);
      router.back();
    } catch (e) {
      showToast({ tone: "error", message: "Couldn't save your profile", description: e instanceof Error ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const bannerSource = banner ? { uri: banner.uri } : serverImage(me?.bannerUrl);
  const current = optionFor(me?.status);

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
        <T className="px-1 text-sm font-semibold">Profile</T>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Pressable onPress={() => void pick("banner")} accessibilityRole="button" accessibilityLabel="Change banner" style={{ height: 162 }}>
          {bannerSource ? (
            <Image source={bannerSource} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={StyleSheet.absoluteFill} className="bg-secondary" />
          )}
          <View
            style={[StyleSheet.absoluteFill, { backgroundImage: `linear-gradient(to bottom, transparent 62%, ${colors.background} 100%)` }]}
          />
          {/* The web shows this on hover; a phone has none, so it is always there. */}
          <View className="absolute right-3 top-3 flex-row items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1">
            <Icon as={Camera} size={13} color="#fff" />
            <T className="text-xs font-medium text-white">Change Banner</T>
          </View>
        </Pressable>

        <View className="px-5" style={{ marginTop: -40 }}>
          <Pressable
            onPress={() => void pick("avatar")}
            accessibilityRole="button"
            accessibilityLabel="Change picture"
            className="self-start rounded-full border-4 border-background"
          >
            {avatar ? (
              <Image source={{ uri: avatar.uri }} style={{ width: 97, height: 97, borderRadius: 48.5 }} />
            ) : (
              <Avatar userId={state.userId ?? undefined} name={me?.displayName || username} url={me?.avatarUrl} size={97} textClassName="text-xl" />
            )}
            <View className="absolute bottom-0 right-0 size-7 items-center justify-center rounded-full border-2 border-background bg-secondary">
              <Icon as={Camera} size={13} tone="secondary-foreground" />
            </View>
          </Pressable>
        </View>

        <View className="items-center gap-1 px-5 pb-4 pt-1">
          <T className="text-lg font-semibold">{displayName.trim() || username}</T>
          {displayName.trim() ? <T className={UI_HINT}>{username}</T> : null}
        </View>

        <View className="gap-3 px-4">
          <SettingsSection title="Identity" hint="Your name and the lines under it. Everyone who can see you sees these.">
            <Field label="Display Name">
              <TextField value={displayName} onChangeText={setDisplayName} placeholder="Set a display name..." maxLength={32} />
            </Field>
            <Field label="Custom Status">
              <TextField value={customStatus} onChangeText={setCustomStatus} placeholder="Set a status..." maxLength={80} />
            </Field>
            <Field label="About Me" hint={<T className="text-right text-3xs text-muted-foreground">{about.length}/200</T>}>
              <TextField value={about} onChangeText={setAbout} placeholder="Tell others about yourself..." maxLength={200} multiline />
            </Field>
          </SettingsSection>

          <SettingsSection title="Availability" hint="Takes effect the moment you pick it — there is nothing to save.">
            <View className="overflow-hidden rounded-md border border-input">
              {STATUS_OPTIONS.map((o, i) => (
                <Pressable
                  key={o.value}
                  onPress={() => setManualStatus(o.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: current === o.value }}
                  className={cn("flex-row items-center gap-2 px-3 py-2.5 active:bg-accent/50", i > 0 && "border-t border-input")}
                >
                  <View className={cn("size-2.5 rounded-full", o.dot)} />
                  <T className="flex-1 text-sm">{o.label}</T>
                  {current === o.value ? <Icon as={Check} size={15} tone="foreground" /> : null}
                </Pressable>
              ))}
            </View>
          </SettingsSection>
        </View>
      </ScrollView>

      {/* One save bar, only once there is something to save (the web's). */}
      {changed ? (
        <Animated.View style={[lift, { paddingBottom: insets.bottom + 8 }]} className="flex-row items-center gap-2 border-t border-border bg-background px-4 pt-3">
          <T className={cn(UI_HINT, "flex-1")}>Unsaved changes</T>
          <Button variant="ghost" size="sm" onPress={reset} disabled={saving}>
            Reset
          </Button>
          <Button size="sm" onPress={() => void save()} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color={colors["primary-foreground"]} /> : "Save"}
          </Button>
        </Animated.View>
      ) : null}
    </View>
  );
}
