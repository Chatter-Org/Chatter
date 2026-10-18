import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, type Href } from "expo-router";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Film,
  Hash,
  HeadphoneOff,
  LayoutList,
  Lock,
  MessageCircle,
  MessagesSquare,
  Mic,
  MicOff,
  Move3d,
  PenTool,
  Plus,
  Sparkles,
  UserRound,
  Users,
  Volume2,
  type LucideProps,
} from "lucide-react-native";
import type { ComponentType } from "react";
import type { Channel, RoomInfo } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useTheme } from "@/theme/ThemeProvider";
import { Avatar } from "./Avatar";
import { usePanels } from "./PanelLayout";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HEADING } from "@/ui/roles";

/**
 * The left panel, built from the web's own parts: the sidebar in its rail
 * form (AppSidebar's collapsed mode) and, beside it, the server's channel
 * list (ChannelList) — two cards, as on the desktop, here on the chat's own
 * background so the drawer and the conversation read as one surface. A
 * phone has room for the rail but not the full sidebar beside the channels,
 * which is the choice the web makes when its sidebar is collapsed.
 */

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

const holdsCall = (c: Channel) => c.channel_type === "voice" || c.channel_type === "spatial";
const tick = () => void Haptics.selectionAsync().catch(() => {});

export function NavPanel({ rail, onRail }: { rail: RailSelection; onRail(selection: RailSelection): void }) {
  const state = useChatter();
  const { selectRoom } = useChatterActions();
  const insets = useSafeAreaInsets();

  const { servers, dms } = useMemo(() => {
    const all = state.joinedRoomIds.map((id) => state.roomInfoMap[id]).filter(Boolean) as RoomInfo[];
    return { servers: all.filter((r) => !r.is_direct), dms: all.filter((r) => r.is_direct) };
  }, [state.joinedRoomIds, state.roomInfoMap]);

  // Who is in a call in each room, from the voice picture the socket keeps
  // (AppSidebar's liveVoice).
  const roomsInVoice = useMemo(() => {
    const rooms = new Set<string>();
    for (const [channelId, members] of Object.entries(state.voiceChannelMembers)) {
      const roomId = state.voiceChannelRooms[channelId];
      if (roomId && members.length > 0) rooms.add(roomId);
    }
    return rooms;
  }, [state.voiceChannelMembers, state.voiceChannelRooms]);

  const dmUnread = dms.some((r) => (state.roomLooseUnreads[r.room_id] ?? 0) > 0);
  const dmMentions = dms.reduce((n, r) => n + (state.roomMentions[r.room_id] ?? 0), 0);
  const me = state.userId ? state.userPresence[state.userId] : undefined;

  const pickServer = (roomId: string) => {
    tick();
    onRail({ kind: "server", roomId });
    if (state.currentRoomId !== roomId) void selectRoom(roomId).catch(() => {});
  };

  return (
    <View
      className="flex-1 flex-row gap-2 bg-background px-2"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}
    >
      {/* The sidebar, as its rail (AppSidebar collapsed). */}
      <View className="w-[4.5rem] items-center gap-2 overflow-hidden rounded-lg border border-border bg-sidebar py-3">
        <RailTile
          label="Direct messages"
          active={rail.kind === "dms"}
          unread={dmUnread}
          mentions={dmMentions}
          onPress={() => {
            tick();
            onRail({ kind: "dms" });
          }}
        >
          {(on) => <Icon as={MessageCircle} size={22} tone={on ? "sidebar-primary-foreground" : "sidebar-foreground"} />}
        </RailTile>
        <View className="h-px w-8 bg-border" />
        <ScrollView className="w-full flex-1" contentContainerClassName="items-center gap-2 pb-1" showsVerticalScrollIndicator={false}>
          {servers.map((room) => {
            const icon = serverImage(room.icon_url);
            const inVoice = roomsInVoice.has(room.room_id);
            return (
              <RailTile
                key={room.room_id}
                label={room.name}
                active={rail.kind === "server" && rail.roomId === room.room_id}
                unread={(state.roomUnreadCounts[room.room_id] ?? 0) > 0}
                mentions={state.roomMentions[room.room_id] ?? 0}
                voice={inVoice}
                onPress={() => pickServer(room.room_id)}
              >
                {(on) =>
                  icon ? (
                    <Image source={icon} style={{ width: TILE, height: TILE }} contentFit="cover" />
                  ) : (
                    <T className={cn("text-base font-semibold", on ? "text-sidebar-primary-foreground" : "text-sidebar-foreground")}>
                      {room.name.trim().slice(0, 1).toUpperCase()}
                    </T>
                  )
                }
              </RailTile>
            );
          })}
        </ScrollView>
        <View className="h-px w-8 bg-border" />
        {/* "You": the web rail's account tile, here the way into settings.
            (The route types name the settings folder's index /settings/index;
            it is served at /settings.) */}
        <RailTile label="Settings and profile" active={false} onPress={() => router.push("/settings" as Href)}>
          {() => (
            <Avatar
              userId={state.userId ?? undefined}
              name={me?.displayName}
              url={me?.avatarUrl}
              size={TILE}
              fallbackClassName="bg-transparent"
              textClassName="text-base font-bold text-sidebar-foreground"
            />
          )}
        </RailTile>
      </View>

      {/* The channel list, or the conversations (ChannelList / the DMs tab). */}
      <View className="flex-1 overflow-hidden rounded-lg border border-border bg-sidebar">
        {rail.kind === "dms" ? <DmList rooms={dms} /> : <ChannelList roomId={rail.roomId} />}
      </View>
    </View>
  );
}

// ─── Rail ────────────────────────────────────────────────────────────────────

/** --rail-icon: 2.55rem at the web's 17.6px rem. */
const TILE = 45;

/**
 * A rail tile: a near-circle that squares off when it is the one you are in,
 * with the pill on the rail's edge (tall for here, a stub for unread) and the
 * mention count on its corner. A press does what a hover does on the web.
 */
const RailTile = memo(function RailTile({
  label,
  active,
  unread,
  mentions = 0,
  voice,
  onPress,
  children,
}: {
  label: string;
  active: boolean;
  unread?: boolean;
  mentions?: number;
  voice?: boolean;
  onPress(): void;
  children: (on: boolean) => ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}${mentions ? `, ${mentions} mentions` : unread ? ", unread" : ""}`}
      accessibilityState={{ selected: active }}
      style={{ width: TILE, height: TILE }}
    >
      {({ pressed }) => {
        const on = active || pressed;
        const pill = active ? TILE * 0.83 : pressed ? TILE * 0.42 : unread ? TILE * 0.17 : 0;
        return (
          <>
            <View
              className="absolute w-1 rounded-r-full bg-sidebar-foreground"
              style={{ left: -12, top: (TILE - pill) / 2, height: pill }}
            />
            <View
              className={cn(
                "items-center justify-center overflow-hidden",
                on ? "rounded-2xl bg-sidebar-primary" : "rounded-3xl bg-sidebar-accent",
              )}
              style={{ width: TILE, height: TILE }}
            >
              {children(on)}
            </View>
            {voice ? (
              <View className="absolute -right-0.5 -top-0.5 h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-sidebar bg-success">
                <Volume2 size={9} color="#fff" />
              </View>
            ) : null}
            {mentions > 0 ? (
              <CountBadge count={mentions} className="absolute -bottom-0.5 -right-0.5 h-[18px] min-w-[18px] border-2 border-sidebar" />
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
});

/** The red count on a tile or row: mentions. */
export function CountBadge({ count, tone = "destructive", className }: { count: number; tone?: "destructive" | "primary"; className?: string }) {
  return (
    <View
      className={cn(
        "h-[17px] min-w-[17px] items-center justify-center rounded-full px-1",
        tone === "destructive" ? "bg-destructive" : "bg-sidebar-primary",
        className,
      )}
    >
      <T className={cn("text-3xs font-bold leading-none", tone === "destructive" ? "text-white" : "text-sidebar-primary-foreground")}>
        {count > 99 ? "99+" : count}
      </T>
    </View>
  );
}

// ─── Channel list ────────────────────────────────────────────────────────────

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
    return [
      { id: "", name: "", channels: channels.filter((c) => !c.category_id) },
      ...[...state.channelCategories].sort(byPosition).map((cat) => ({
        id: cat.category_id,
        name: cat.name,
        channels: channels.filter((c) => c.category_id === cat.category_id),
      })),
    ].filter((s) => s.channels.length > 0 || s.id);
  }, [state.channels, state.channelCategories]);

  const open = (channel: Channel) => {
    tick();
    // A voice channel is a call: tapping it walks in (as on the web), and the
    // conversation on screen stays where it was.
    if (holdsCall(channel)) {
      if (state.voiceChannelId !== channel.channel_id) void voice.join(channel.channel_id);
      return;
    }
    if (channel.channel_id !== state.currentChannelId) void selectChannel(channel.channel_id).catch(() => {});
    close();
  };

  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between border-b border-border px-3 py-2">
        <T className="flex-1 text-sm font-semibold" numberOfLines={1}>
          {room?.name ?? "Server"}
        </T>
      </View>
      {banner ? <Banner uri={banner} /> : null}
      {!loaded ? (
        <T className="px-3 py-3 text-xs text-muted-foreground">Loading channels…</T>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="py-1 pb-4">
          {sections.map((section) => (
            <View key={section.id || "loose"}>
              {section.name ? (
                <Pressable
                  onPress={() => setCollapsed((c) => ({ ...c, [section.id]: !c[section.id] }))}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !collapsed[section.id] }}
                  className="mt-3 flex-row items-center gap-1 px-2 py-1"
                >
                  <Icon as={collapsed[section.id] ? ChevronRight : ChevronDown} size={13} />
                  <T className={UI_HEADING} numberOfLines={1}>
                    {section.name}
                  </T>
                </Pressable>
              ) : null}
              {!collapsed[section.id] &&
                section.channels.map((channel) => (
                  <ChannelRow
                    key={channel.channel_id}
                    channel={channel}
                    selected={holdsCall(channel) ? channel.channel_id === state.voiceChannelId : channel.channel_id === state.currentChannelId}
                    unread={holdsCall(channel) ? 0 : (state.channelUnreadCounts[channel.channel_id] ?? 0)}
                    mentions={holdsCall(channel) ? 0 : (state.channelMentions[channel.channel_id] ?? 0)}
                    occupiedSince={state.voiceChannelOccupiedSince[channel.channel_id]}
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

/** The server banner, fading into the panel below it. */
function Banner({ uri }: { uri: { uri: string; headers?: Record<string, string> } }) {
  const { colors } = useTheme();
  return (
    <View className="h-24 overflow-hidden">
      <Image source={uri} style={{ width: "100%", height: "100%" }} contentFit="cover" />
      <Svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.5" stopColor={colors.sidebar} stopOpacity={0} />
            <Stop offset="1" stopColor={colors.sidebar} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#fade)" />
      </Svg>
    </View>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  selected,
  unread,
  mentions,
  occupiedSince,
  onPress,
}: {
  channel: Channel;
  selected: boolean;
  unread: number;
  mentions: number;
  occupiedSince?: number;
  onPress(): void;
}) {
  const state = useChatter();
  const locked = (channel.view_roles?.length ?? 0) > 0;
  const occupants = holdsCall(channel) ? (state.voiceChannelMembers[channel.channel_id] ?? []) : [];
  const bold = !selected && unread > 0;
  return (
    <View className="mt-1">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${channel.name}, ${channel.channel_type} channel${unread ? `, ${unread} unread` : ""}${mentions ? `, ${mentions} mentions` : ""}`}
        accessibilityState={{ selected }}
        className={cn("mx-1 flex-row items-center gap-1 rounded px-2 py-1.5", selected ? "bg-accent" : "active:bg-accent/50")}
      >
        {bold ? <T className="text-xs font-bold text-foreground">[{unread > 99 ? "99+" : unread}]</T> : null}
        <Icon as={locked ? Lock : (CHANNEL_ICON[channel.channel_type] ?? Hash)} size={17} tone={locked ? "warning" : "muted-foreground"} />
        <T
          numberOfLines={1}
          className={cn(
            "flex-1 text-sm",
            selected ? "text-accent-foreground" : bold ? "font-bold text-foreground" : "text-muted-foreground",
          )}
        >
          {channel.name}
        </T>
        {occupants.length > 0 && occupiedSince ? <VoiceTimer since={occupiedSince} /> : null}
        {mentions > 0 ? <CountBadge count={mentions} className="ml-auto h-4 min-w-4" /> : null}
      </Pressable>
      <ThreadPreviews channel={channel} />
      {occupants.length > 0 ? (
        <View className="ml-7 gap-0.5 pb-1">
          {occupants.map((m) => (
            <Occupant key={m.userId} userId={m.userId} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

/**
 * The channel's recently active threads, hung under it on a tree line as the
 * web's channel list shows them. Tapping one opens the channel and the thread.
 */
function ThreadPreviews({ channel }: { channel: Channel }) {
  const state = useChatter();
  const { selectChannel, openThread } = useChatterActions();
  const { close } = usePanels();
  const threads = state.channelThreads[channel.channel_id];
  if (!threads?.length) return null;
  const open = async (threadId: string) => {
    tick();
    close();
    if (state.currentChannelId !== channel.channel_id) await selectChannel(channel.channel_id).catch(() => {});
    void openThread(threadId).catch(() => {});
    router.push("/thread");
  };
  return (
    <View className="ml-5 pb-1 pr-1">
      {threads.map((t, i) => {
        const last = i === threads.length - 1;
        const mentions = state.threadMentions[t.threadId] ?? 0;
        const active = state.activeThreadEventId === t.threadId;
        return (
          <View key={t.threadId} className="relative pl-3">
            {/* The tree: a line down past every thread but the last, and an
                elbow into each. */}
            {!last ? <View className="absolute bottom-0 left-0 top-0 w-0 border-l-2 border-muted-foreground/60" /> : null}
            <View className="absolute -top-0.5 left-0 h-3.5 w-2 rounded-bl-md border-b-2 border-l-2 border-muted-foreground/60" />
            <Pressable
              onPress={() => void open(t.threadId)}
              accessibilityRole="button"
              accessibilityLabel={`Thread ${t.name || "untitled"}, ${t.replyCount} replies`}
              className={cn("flex-row items-center gap-1.5 rounded px-1 py-1", active ? "bg-accent" : "active:bg-accent/50")}
            >
              <Icon as={MessagesSquare} size={13} tone={active ? "foreground" : "muted-foreground"} />
              <T className={cn("flex-1 text-xs", active ? "text-foreground" : "text-muted-foreground")} numberOfLines={1}>
                {t.name || "Thread"}
              </T>
              <T className="text-xs text-muted-foreground opacity-70">{t.replyCount}</T>
              {mentions > 0 ? <CountBadge count={mentions} className="h-3.5 min-w-3.5" /> : null}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** How long a voice channel has been occupied (m:ss), beside its name. */
function VoiceTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return <T className="ml-1 text-3xs text-success">{h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`}</T>;
}

/** Someone in a voice channel: their mic, face and name. */
function Occupant({ userId }: { userId: string }) {
  const state = useChatter();
  const flags = state.voiceMemberStates[userId];
  const isMe = userId === state.userId;
  const deafened = flags?.deafened || (isMe && state.isDeafened);
  const muted = deafened || flags?.muted || (isMe && state.isMuted);
  const presence = state.userPresence[userId];
  return (
    <View className="flex-row items-center gap-1.5 rounded px-1 py-0.5">
      <Icon as={muted ? MicOff : Mic} size={13} tone={muted ? "destructive" : "success"} />
      {deafened ? <Icon as={HeadphoneOff} size={13} tone="destructive" /> : null}
      <Avatar userId={userId} name={presence?.displayName} url={presence?.avatarUrl} size={22} textClassName="text-2xs" />
      <T className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
        {presence?.displayName || displayUserId(userId)}
      </T>
    </View>
  );
}

// ─── Direct messages ─────────────────────────────────────────────────────────

function DmList({ rooms }: { rooms: RoomInfo[] }) {
  const state = useChatter();
  const { selectRoom } = useChatterActions();
  const { close } = usePanels();
  const me = state.userId;
  const requests = state.incomingFriendRequests.length;
  return (
    <View className="flex-1">
      <View className="flex-row items-center border-b border-border py-1 pl-3 pr-1">
        <T className="flex-1 text-sm font-semibold">Direct Messages</T>
        <Pressable
          onPress={() => {
            close();
            router.push("/people");
          }}
          accessibilityRole="button"
          accessibilityLabel="New message"
          hitSlop={4}
          className="size-9 items-center justify-center rounded-md active:bg-sidebar-accent"
        >
          <Icon as={Plus} size={18} />
        </Pressable>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="gap-px px-2 py-2">
        {/* Friends, as Discord's phone app puts them: first in the list. */}
        <RoomRow
          name="Friends"
          active={false}
          unread={0}
          mentions={requests}
          icon={
            <View className="h-[31px] w-[31px] items-center justify-center rounded-md bg-sidebar-accent">
              <Icon as={UserRound} size={17} tone="sidebar-foreground" />
            </View>
          }
          onPress={() => {
            close();
            router.push("/friends");
          }}
        />
        <View className="mx-2 my-1 h-px bg-border" />
        {rooms.length === 0 ? (
          <T className="px-3 py-3 text-xs text-muted-foreground">No conversations yet. Start one with the + above.</T>
        ) : null}
        {rooms.map((room) => {
          // Self is filtered out server-side, and again here (AppSidebar).
          const others = (room.dm_user_ids ?? []).filter((id) => id !== me);
          const peer = others.length === 1 ? others[0] : null;
          const name = (peer && state.userPresence[peer]?.displayName) || room.name.replace(/^DM with /, "");
          const avatar = (peer && (state.userPresence[peer]?.avatarUrl || room.dm_avatars?.[peer])) || null;
          return (
            <RoomRow
              key={room.room_id}
              name={name}
              active={state.currentRoomId === room.room_id}
              unread={state.roomLooseUnreads[room.room_id] ?? 0}
              mentions={state.roomMentions[room.room_id] ?? 0}
              icon={
                peer ? (
                  <Avatar userId={peer} name={name} url={avatar} size={31} status={state.userPresence[peer]?.status} ring="sidebar" />
                ) : (
                  // A group has no single face to show.
                  <View className="h-[31px] w-[31px] items-center justify-center rounded-full bg-sidebar-accent">
                    <Icon as={Users} size={16} tone="sidebar-foreground" />
                  </View>
                )
              }
              onPress={() => {
                tick();
                if (state.currentRoomId !== room.room_id) void selectRoom(room.room_id).catch(() => {});
                close();
              }}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * A room or conversation in a list (AppSidebar's room card): its picture or
 * letter, its name, and on the right what is waiting there. The bar on the
 * left marks the open one; a dot, one with something unread.
 */
const RoomRow = memo(function RoomRow({
  name,
  active,
  unread,
  mentions,
  icon,
  onPress,
}: {
  name: string;
  active: boolean;
  unread: number;
  mentions: number;
  icon?: ReactNode;
  onPress(): void;
}) {
  const waiting = !active && (unread > 0 || mentions > 0);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={cn("relative flex-row items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5", active ? "bg-sidebar-accent" : "active:bg-sidebar-accent/50")}
    >
      {active ? (
        <View className="absolute left-0 h-5 w-0.5 rounded-r-full bg-sidebar-primary" />
      ) : waiting ? (
        <View className="absolute left-1 size-1.5 rounded-full bg-sidebar-foreground" />
      ) : null}
      {icon ?? (
        <View className={cn("h-[31px] w-[31px] items-center justify-center rounded-md", active ? "bg-sidebar-primary" : "bg-sidebar-accent")}>
          <T className={cn("text-xs font-bold", active ? "text-sidebar-primary-foreground" : "text-sidebar-foreground")}>
            {name.slice(0, 1).toUpperCase()}
          </T>
        </View>
      )}
      <T className={cn("flex-1 text-sm", active && "text-sidebar-accent-foreground")} numberOfLines={1}>
        {name}
      </T>
      {!active && mentions > 0 ? (
        <CountBadge count={mentions} />
      ) : !active && unread > 0 ? (
        <CountBadge count={unread} tone="primary" />
      ) : null}
    </Pressable>
  );
});
