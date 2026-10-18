import { useMemo, useState } from "react";
import { Image } from "expo-image";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, Play, Users } from "lucide-react-native";
import { resolveNotificationLevel, settingsKey, type NotificationLevel } from "@chatter/core/notifications";
import { loadSoundSettings, saveSoundSettings, type SoundSettings } from "@chatter/core/soundRules";
import { displayUserId } from "@chatter/core/utils";
import { useChatter } from "@/state/ChatterProvider";
import { NotificationSheet } from "@/components/NotificationSheet";
import { Avatar } from "@/components/Avatar";
import { playSound } from "@/platform/sounds";
import { Button, Switch } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Slider } from "@/ui/Slider";
import { Icon, T } from "@/ui/primitives";
import { serverImage } from "@/ui/media";
import { UI_HEADING, UI_HINT } from "@/ui/roles";
import { SettingsSection } from "@/ui/settings";

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  all: "All messages",
  mentions: "Only @mentions",
  none: "Nothing",
};

/**
 * What each server and conversation tells you — the levels the web sets from
 * each room's bell, all in one place — and the sound effects, which the web
 * keeps under its profile dialog's Device tab. Both stay on the account and
 * on this phone respectively, as on the web.
 */
export default function NotificationSettings() {
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState<{ roomId: string; name: string } | null>(null);
  const [sounds, setSounds] = useState<SoundSettings>(loadSoundSettings);

  const updateSounds = (patch: Partial<SoundSettings>) => {
    const next = { ...sounds, ...patch };
    setSounds(next);
    saveSoundSettings(next);
  };

  const { servers, dms } = useMemo(() => {
    const rooms = state.joinedRoomIds.map((id) => state.roomInfoMap[id]).filter(Boolean);
    return {
      servers: rooms.filter((r) => !r.is_direct).sort((a, b) => a.name.localeCompare(b.name)),
      dms: rooms.filter((r) => r.is_direct),
    };
  }, [state.joinedRoomIds, state.roomInfoMap]);

  const dmName = (room: (typeof dms)[number]) => {
    const others = (room.dm_user_ids ?? []).filter((id) => id !== state.userId);
    const peer = others.length === 1 ? others[0] : null;
    return { peer, name: (peer && (state.userPresence[peer]?.displayName || displayUserId(peer))) || room.name.replace(/^DM with /, "") };
  };

  const row = (roomId: string, name: string, icon: React.ReactNode) => {
    const level = resolveNotificationLevel(state.notificationSettings, roomId);
    const channelOverrides = Object.keys(state.notificationSettings).filter((k) => k.startsWith(settingsKey(roomId, "")) && k !== settingsKey(roomId, "")).length;
    return (
      <Pressable
        key={roomId}
        onPress={() => setEditing({ roomId, name })}
        accessibilityRole="button"
        accessibilityHint="Choose how this one notifies you"
        className="flex-row items-center gap-3 px-3 py-2.5 active:bg-accent"
      >
        {icon}
        <View className="min-w-0 flex-1">
          <T className="text-sm" numberOfLines={1}>
            {name}
          </T>
          <T className={UI_HINT} numberOfLines={1}>
            {LEVEL_LABEL[level]}
            {channelOverrides > 0 ? ` · ${channelOverrides} channel${channelOverrides === 1 ? "" : "s"} set differently` : ""}
          </T>
        </View>
        <Icon as={ChevronRight} size={16} />
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Notifications" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-6 p-4">
        <SettingsSection title="Sound effects" hint="Mentions, voice joins, and other people's entrance sounds. Rooms can replace these with their own. Kept on this phone.">
          <View className="flex-row items-center justify-between gap-3">
            <T className="flex-1 text-sm">Play sound effects</T>
            <Switch value={sounds.enabled} onValueChange={(enabled) => updateSounds({ enabled })} accessibilityLabel="Play sound effects" />
          </View>
          {sounds.enabled ? (
            <View className="gap-1">
              <View className="flex-row items-center justify-between">
                <T className="text-xs font-medium">Volume</T>
                <T className="text-3xs text-muted-foreground">{Math.round(sounds.volume * 100)}%</T>
              </View>
              <Slider
                value={sounds.volume}
                min={0}
                max={1}
                step={0.05}
                accessibilityLabel="Sound effect volume"
                onChange={(volume) => setSounds((s) => ({ ...s, volume }))}
                // Saved and played once, when the finger lifts.
                onCommit={(volume) => {
                  updateSounds({ volume });
                  playSound("mention");
                }}
              />
              <Button variant="ghost" size="sm" icon={Play} className="self-start" onPress={() => playSound("mention")}>
                Test
              </Button>
            </View>
          ) : null}
        </SettingsSection>

        <View className="gap-2">
          <T className={UI_HEADING}>Servers</T>
          <T className={UI_HINT}>A channel can be set apart from its server from the bell in its header.</T>
          <View className="overflow-hidden rounded-lg border border-border">
            {servers.length === 0 ? <T className="p-3 text-sm text-muted-foreground">No servers yet.</T> : null}
            {servers.map((room) =>
              row(
                room.room_id,
                room.name,
                room.icon_url ? (
                  <Image source={serverImage(room.icon_url)} style={{ width: 31, height: 31, borderRadius: 8 }} />
                ) : (
                  <View className="size-[31px] items-center justify-center rounded-lg bg-secondary">
                    <T className="text-xs font-bold">{room.name.slice(0, 1).toUpperCase()}</T>
                  </View>
                ),
              ),
            )}
          </View>
        </View>

        {dms.length > 0 ? (
          <View className="gap-2">
            <T className={UI_HEADING}>Direct messages</T>
            <View className="overflow-hidden rounded-lg border border-border">
              {dms.map((room) => {
                const { peer, name } = dmName(room);
                return row(
                  room.room_id,
                  name,
                  peer ? (
                    <Avatar userId={peer} name={name} url={state.userPresence[peer]?.avatarUrl ?? room.dm_avatars?.[peer]} size={31} />
                  ) : (
                    <View className="size-[31px] items-center justify-center rounded-full bg-secondary">
                      <Icon as={Users} size={15} />
                    </View>
                  ),
                );
              })}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <NotificationSheet open={!!editing} onClose={() => setEditing(null)} roomId={editing?.roomId} title={editing?.name} />
    </View>
  );
}
