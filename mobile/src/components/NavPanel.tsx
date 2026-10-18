import { memo, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Film,
  Hash,
  LayoutList,
  MessageCircle,
  Move3d,
  PenTool,
  Settings,
  Sparkles,
  Volume2,
  type LucideProps,
} from "lucide-react-native";
import type { ComponentType } from "react";
import type { Channel, RoomInfo } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { usePanels } from "./PanelLayout";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";

/** What the rail has picked: a server, or the direct messages list. */
export type RailSelection = { kind: "dms" } | { kind: "server"; roomId: string };

const CHANNEL_ICON: Record<Channel["channel_type"], ComponentType<LucideProps>> = {
  text: Hash,
  voice: Volume2,
  spatial: Move3d,
  theater: Film,
  forum: LayoutList,
  whiteboard: PenTool,
  showcase: Sparkles,
  bot: Bot,
};

const tick = () => void Haptics.selectionAsync().catch(() => {});

/**
 * The left panel: the server rail and, beside it, the selected server's
 * channels — or the direct messages, when the rail's top button is picked.
 */
export function NavPanel({ rail, onRail }: { rail: RailSelection; onRail(selection: RailSelection): void }) {
  const state = useChatter();
  const { selectRoom } = useChatterActions();
  const insets = useSafeAreaInsets();

  const { servers, dms } = useMemo(() => {
    const all = state.joinedRoomIds.map((id) => state.roomInfoMap[id]).filter(Boolean) as RoomInfo[];
    return {
      servers: all.filter((r) => !r.is_direct),
      dms: all.filter((r) => r.is_direct),
    };
  }, [state.joinedRoomIds, state.roomInfoMap]);

  const dmUnread = dms.some((r) => (state.roomLooseUnreads[r.room_id] ?? 0) > 0);
  const dmMentions = dms.reduce((n, r) => n + (state.roomMentions[r.room_id] ?? 0), 0);

  const pickServer = (roomId: string) => {
    tick();
    onRail({ kind: "server", roomId });
    if (state.currentRoomId !== roomId) void selectRoom(roomId).catch(() => {});
  };

  return (
    <View className="flex-1 flex-row bg-sidebar" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
      {/* Rail */}
      <View className="w-[72px] items-center pt-2 pb-3">
        <RailButton
          label="Direct messages"
          active={rail.kind === "dms"}
          unread={dmUnread}
          mentions={dmMentions}
          onPress={() => {
            tick();
            onRail({ kind: "dms" });
          }}
        >
          <Icon as={MessageCircle} tone={rail.kind === "dms" ? "sidebar-primary-foreground" : "sidebar-foreground"} size={22} />
        </RailButton>
        <View className="my-2 h-px w-8 bg-sidebar-border" />
        <ScrollView className="w-full" contentContainerClassName="items-center gap-2 pb-2" showsVerticalScrollIndicator={false}>
          {servers.map((room) => (
            <RailButton
              key={room.room_id}
              label={room.name}
              active={rail.kind === "server" && rail.roomId === room.room_id}
              unread={(state.roomUnreadCounts[room.room_id] ?? 0) > 0}
              mentions={state.roomMentions[room.room_id] ?? 0}
              onPress={() => pickServer(room.room_id)}
              imageUrl={room.icon_url}
            >
              <T
                className={cn(
                  "font-mono-medium text-sm",
                  rail.kind === "server" && rail.roomId === room.room_id ? "text-sidebar-primary-foreground" : "text-sidebar-foreground",
                )}
              >
                {initials(room.name)}
              </T>
            </RailButton>
          ))}
        </ScrollView>
        <RailButton label="Settings" active={false} onPress={() => router.push("/settings")}>
          <Icon as={Settings} tone="sidebar-foreground" size={20} />
        </RailButton>
      </View>

      {/* Channels or conversations */}
      <View className="flex-1 mr-2 mb-2 mt-2 overflow-hidden rounded-xl bg-card">
        {rail.kind === "dms" ? <DmList rooms={dms} /> : <ChannelList roomId={rail.roomId} />}
      </View>
    </View>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

const RailButton = memo(function RailButton({
  label,
  active,
  unread,
  mentions = 0,
  imageUrl,
  onPress,
  children,
}: {
  label: string;
  active: boolean;
  unread?: boolean;
  mentions?: number;
  imageUrl?: string;
  onPress(): void;
  children?: React.ReactNode;
}) {
  const source = serverImage(imageUrl);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} className="relative w-full items-center">
      {/* The pill on the rail's edge: unread, or the one you're in. */}
      {(active || unread) && (
        <View className={cn("absolute left-0 w-1 rounded-r-full bg-sidebar-foreground", active ? "top-1 h-10" : "top-4 h-4")} />
      )}
      <View
        className={cn(
          "h-12 w-12 items-center justify-center overflow-hidden",
          active ? "rounded-xl bg-sidebar-primary" : "rounded-3xl bg-sidebar-accent",
        )}
      >
        {source ? <Image source={source} style={{ width: 48, height: 48 }} contentFit="cover" /> : children}
      </View>
      {mentions > 0 && <CountBadge count={mentions} className="absolute -bottom-0.5 right-2" />}
    </Pressable>
  );
});

export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <View className={cn("min-w-5 items-center rounded-full border-2 border-sidebar bg-destructive px-1", className)}>
      <T className="text-[10px] leading-4 text-white">{count > 99 ? "99+" : count}</T>
    </View>
  );
}

function ChannelList({ roomId }: { roomId: string }) {
  const state = useChatter();
  const { selectChannel, voice } = useChatterActions();
  const { close } = usePanels();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const room = state.roomInfoMap[roomId];
  const loaded = state.currentRoomId === roomId;
  const banner = serverImage(room?.banner_url);

  const sections = useMemo(() => {
    const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
    const channels = [...state.channels].sort(byPosition);
    const loose = channels.filter((c) => !c.category_id);
    return [
      { id: "", name: "", channels: loose },
      ...[...state.channelCategories].sort(byPosition).map((cat) => ({
        id: cat.category_id,
        name: cat.name,
        channels: channels.filter((c) => c.category_id === cat.category_id),
      })),
    ].filter((s) => s.channels.length > 0 || s.id);
  }, [state.channels, state.channelCategories]);

  const open = (channel: Channel) => {
    tick();
    // A voice channel is a call: tapping it walks in (as on the web), and
    // the conversation on screen stays where it was.
    if (channel.channel_type === "voice" || channel.channel_type === "spatial") {
      if (state.voiceChannelId !== channel.channel_id) void voice.join(channel.channel_id);
      return;
    }
    if (channel.channel_id !== state.currentChannelId) void selectChannel(channel.channel_id).catch(() => {});
    close();
  };

  return (
    <View className="flex-1">
      <View className="px-4 pt-3 pb-2">
        <T className="font-mono-bold text-base" numberOfLines={1}>
          {room?.name ?? "Server"}
        </T>
        {room?.topic ? (
          <T className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {room.topic}
          </T>
        ) : null}
      </View>
      {banner ? <Image source={banner} style={{ height: 96, marginHorizontal: 8, borderRadius: 10 }} contentFit="cover" /> : null}
      {!loaded ? (
        <T className="p-4 text-xs text-muted-foreground">Loading channels…</T>
      ) : (
        <ScrollView contentContainerClassName="px-2 pb-4">
          {sections.map((section) => (
            <View key={section.id || "loose"} className="mt-2">
              {section.name ? (
                <Pressable
                  onPress={() => setCollapsed((c) => ({ ...c, [section.id]: !c[section.id] }))}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !collapsed[section.id] }}
                  className="flex-row items-center gap-1 px-1 py-1.5"
                >
                  <Icon as={collapsed[section.id] ? ChevronRight : ChevronDown} size={12} />
                  <T className="text-[11px] uppercase tracking-widest text-muted-foreground">{section.name}</T>
                </Pressable>
              ) : null}
              {!collapsed[section.id] &&
                section.channels.map((channel) => (
                  <ChannelRow
                    key={channel.channel_id}
                    channel={channel}
                    active={
                      channel.channel_type === "voice" || channel.channel_type === "spatial"
                        ? channel.channel_id === state.voiceChannelId
                        : channel.channel_id === state.currentChannelId
                    }
                    unread={(state.channelUnreadCounts[channel.channel_id] ?? 0) > 0}
                    mentions={state.channelMentions[channel.channel_id] ?? 0}
                    voiceMembers={state.voiceChannelMembers[channel.channel_id]}
                    presence={state.userPresence}
                    onPress={() => open(channel)}
                  />
                ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  unread,
  mentions,
  voiceMembers,
  presence,
  onPress,
}: {
  channel: Channel;
  active: boolean;
  unread: boolean;
  mentions: number;
  voiceMembers?: { userId: string }[];
  presence: ReturnType<typeof useChatter>["userPresence"];
  onPress(): void;
}) {
  const icon = CHANNEL_ICON[channel.channel_type] ?? Hash;
  return (
    <View>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${channel.name}, ${channel.channel_type} channel${unread ? ", unread" : ""}`}
        accessibilityState={{ selected: active }}
        className={cn("flex-row items-center gap-2 rounded-lg px-3 py-2.5", active ? "bg-sidebar-primary" : "active:bg-sidebar-accent")}
      >
        <Icon as={icon} size={17} tone={active ? "sidebar-primary-foreground" : "muted-foreground"} />
        <T
          numberOfLines={1}
          className={cn(
            "flex-1 text-[15px]",
            active ? "text-sidebar-primary-foreground" : unread ? "font-mono-bold text-foreground" : "text-muted-foreground",
          )}
        >
          {channel.name}
        </T>
        {mentions > 0 && <CountBadge count={mentions} className="border-0" />}
      </Pressable>
      {voiceMembers?.length ? (
        <View className="ml-9 mb-1 gap-1">
          {voiceMembers.map((m) => (
            <View key={m.userId} className="flex-row items-center gap-2">
              <Avatar userId={m.userId} url={presence[m.userId]?.avatarUrl} size={20} />
              <T className="text-xs text-muted-foreground" numberOfLines={1}>
                {presence[m.userId]?.displayName || displayUserId(m.userId)}
              </T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

function DmList({ rooms }: { rooms: RoomInfo[] }) {
  const state = useChatter();
  const { selectRoom } = useChatterActions();
  const { close } = usePanels();
  const me = state.userId;
  return (
    <View className="flex-1">
      <T className="px-4 pt-3 pb-2 font-mono-bold text-base">Direct messages</T>
      <ScrollView contentContainerClassName="px-2 pb-4">
        {rooms.length === 0 ? (
          <T className="px-2 py-4 text-xs text-muted-foreground">No conversations yet. Start one from someone's profile.</T>
        ) : null}
        {rooms.map((room) => {
          const peer = room.dm_user_ids?.find((id) => id !== me) ?? room.dm_user_ids?.[0];
          const name = (peer && state.userPresence[peer]?.displayName) || room.name;
          const active = state.currentRoomId === room.room_id;
          const unread = (state.roomLooseUnreads[room.room_id] ?? 0) > 0;
          return (
            <Pressable
              key={room.room_id}
              onPress={() => {
                tick();
                if (!active) void selectRoom(room.room_id).catch(() => {});
                close();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              className={cn("flex-row items-center gap-3 rounded-lg px-2 py-2", active ? "bg-sidebar-accent" : "active:bg-sidebar-accent")}
            >
              <Avatar userId={peer} name={name} url={(peer && state.userPresence[peer]?.avatarUrl) || (peer && room.dm_avatars?.[peer])} status={peer ? state.userPresence[peer]?.status : undefined} />
              <T numberOfLines={1} className={cn("flex-1", unread ? "font-mono-bold" : "text-muted-foreground")}>
                {name}
              </T>
              {(state.roomMentions[room.room_id] ?? 0) > 0 && <CountBadge count={state.roomMentions[room.room_id]} className="border-0" />}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
