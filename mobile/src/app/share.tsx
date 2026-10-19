import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { ChevronDown, ChevronRight, File as FileIcon, Hash, Search, Users, X } from "lucide-react-native";
import { apiGetChannels, type Channel, type RoomInfo } from "@chatter/core/api";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { dropIncomingShare, handShareToComposer, useIncomingShare, type SharedContent } from "@/platform/shareIn";
import { Avatar } from "@/components/Avatar";
import { serverImage } from "@/ui/media";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING, UI_HINT, UI_META } from "@/ui/roles";
import { useTheme } from "@/theme/ThemeProvider";

/** Where a shared message can go: channels you write in, not calls or forums. */
const writable = (c: Channel) => c.channel_type === "text" || c.channel_type === "bot";

/**
 * Something shared from another app — a link, a picture, a few files — and
 * where it should go: a DM, or a channel of one of your servers. Picking one
 * opens that conversation with the share in its box, ready to finish and send.
 */
export default function Share() {
  const share = useIncomingShare();
  const state = useChatter();
  const { selectRoom, selectChannel } = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [channels, setChannels] = useState<Record<string, Channel[] | "loading" | "failed">>({});
  const [going, setGoing] = useState(false);

  // The share is what this screen is for; gone (sent on, or let go), so is the screen.
  const [kept] = useState(share);
  useEffect(() => {
    if (!share && !going) router.back();
  }, [share, going]);

  const me = state.userId;
  const { servers, dms } = useMemo(() => {
    const all = state.joinedRoomIds.map((id) => state.roomInfoMap[id]).filter(Boolean) as RoomInfo[];
    return { servers: all.filter((r) => !r.is_direct), dms: all.filter((r) => r.is_direct) };
  }, [state.joinedRoomIds, state.roomInfoMap]);

  const dmName = (room: RoomInfo) => {
    const others = (room.dm_user_ids ?? []).filter((id) => id !== me);
    const peer = others.length === 1 ? others[0] : null;
    return { peer, name: (peer && state.userPresence[peer]?.displayName) || room.name.replace(/^DM with /, "") };
  };

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);

  const loadChannels = (roomId: string) => {
    if (channels[roomId] && channels[roomId] !== "failed") return;
    setChannels((c) => ({ ...c, [roomId]: "loading" }));
    apiGetChannels(roomId)
      .then(({ channels: list }) => setChannels((c) => ({ ...c, [roomId]: list.filter(writable) })))
      .catch(() => setChannels((c) => ({ ...c, [roomId]: "failed" })));
  };

  const toggle = (roomId: string) => {
    setOpen((o) => (o === roomId ? null : roomId));
    loadChannels(roomId);
  };

  const go = async (roomId: string, channelId: string) => {
    const content: SharedContent | null = share ?? kept;
    if (!content || going) return;
    setGoing(true);
    try {
      if (state.currentRoomId !== roomId) await selectRoom(roomId);
      if (channelId) await selectChannel(channelId);
      handShareToComposer(content, roomId, channelId);
      router.back();
    } catch {
      setGoing(false);
    }
  };

  // Letting the share go closes the screen (the effect above).
  const cancel = () => dropIncomingShare();

  const search = (text: string) => {
    // Channel names are found once the servers' channels are in.
    if (text.trim() && !query.trim()) servers.forEach((r) => loadChannels(r.room_id));
    setQuery(text);
  };

  const content = share ?? kept;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={cancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={X} size={22} />
        </Pressable>
        <T className="flex-1 px-1 text-sm font-semibold">Share to…</T>
        {going ? <ActivityIndicator className="mr-3" color={colors["muted-foreground"]} /> : null}
      </View>

      {content ? <Preview content={content} /> : null}

      <View className="mx-3 mb-1 mt-2 flex-row items-center rounded-md border border-input pl-2.5">
        <Icon as={Search} size={15} />
        <TextInput
          value={query}
          onChangeText={search}
          placeholder="Find a conversation..."
          placeholderTextColor={colors["muted-foreground"]}
          autoCapitalize="none"
          autoCorrect={false}
          className="h-10 flex-1 px-2 font-mono text-sm text-foreground"
        />
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }} contentContainerClassName="px-2">
        {dms.some((r) => matches(dmName(r).name)) ? <T className={cn(UI_HEADING, "px-2 pb-1 pt-3")}>Direct messages</T> : null}
        {dms.map((room) => {
          const { peer, name } = dmName(room);
          if (!matches(name)) return null;
          return (
            <Row key={room.room_id} label={name} disabled={going} onPress={() => void go(room.room_id, "")}>
              {peer ? (
                <Avatar userId={peer} name={name} url={state.userPresence[peer]?.avatarUrl} size={32} />
              ) : (
                <View className="size-8 items-center justify-center rounded-full bg-secondary">
                  <Icon as={Users} size={16} />
                </View>
              )}
            </Row>
          );
        })}

        {servers.length > 0 ? <T className={cn(UI_HEADING, "px-2 pb-1 pt-4")}>Servers</T> : null}
        {servers.map((room) => {
          const list = channels[room.room_id];
          const shown = Array.isArray(list) ? list.filter((c) => matches(c.name) || matches(room.name)) : [];
          // A search opens what it finds: the servers that match by name or
          // (once their channels are in) by a channel's.
          const expanded = open === room.room_id || (!!q && shown.length > 0);
          if (q && !matches(room.name) && shown.length === 0) return null;
          return (
            <View key={room.room_id}>
              <Row label={room.name} disabled={going} onPress={() => toggle(room.room_id)} trailing={expanded ? ChevronDown : ChevronRight}>
                {room.icon_url ? (
                  <Image source={serverImage(room.icon_url)} style={{ width: 32, height: 32, borderRadius: 8 }} contentFit="cover" />
                ) : (
                  <View className="size-8 items-center justify-center rounded-lg bg-secondary">
                    <T className="text-sm font-semibold">{room.name.slice(0, 1).toUpperCase()}</T>
                  </View>
                )}
              </Row>
              {expanded ? (
                <View className="ml-6 border-l border-border pl-2">
                  {list === "loading" ? <ActivityIndicator className="py-2" color={colors["muted-foreground"]} /> : null}
                  {list === "failed" ? <T className={cn(UI_HINT, "px-2 py-2")}>Couldn't load its channels.</T> : null}
                  {Array.isArray(list) && list.length === 0 ? <T className={cn(UI_HINT, "px-2 py-2")}>No channels to write in.</T> : null}
                  {shown.map((c) => (
                    <Row key={c.channel_id} label={c.name} disabled={going} onPress={() => void go(room.room_id, c.channel_id)}>
                      <Icon as={Hash} size={16} />
                    </Row>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** What is being shared: the text, and the files as pictures or names. */
function Preview({ content }: { content: SharedContent }) {
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      {content.text ? (
        <T className="text-sm text-muted-foreground" numberOfLines={3}>
          {content.text}
        </T>
      ) : null}
      {content.files.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          {content.files.map((f) =>
            f.type?.startsWith("image/") ? (
              <Image key={f.uri} source={{ uri: f.uri }} style={{ width: 64, height: 64, borderRadius: 6 }} contentFit="cover" />
            ) : (
              <View key={f.uri} className="h-16 w-28 justify-center gap-1 rounded-md border border-border px-2">
                <Icon as={FileIcon} size={16} />
                <T className={UI_META} numberOfLines={2}>
                  {f.name}
                </T>
              </View>
            ),
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

function Row({
  label,
  children,
  trailing,
  disabled,
  onPress,
}: {
  label: string;
  children: ReactNode;
  trailing?: typeof ChevronRight;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="min-h-12 flex-row items-center gap-3 rounded-md px-2 py-1.5 active:bg-accent"
    >
      {children}
      <T className="flex-1 text-sm" numberOfLines={1}>
        {label}
      </T>
      {trailing ? <Icon as={trailing} size={16} /> : null}
    </Pressable>
  );
}
