import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AtSign, Bell, BellOff, CalendarDays, Menu, Pin, Search, UserPlus, Users, WifiOff, type LucideProps } from "lucide-react-native";
import { resolveNotificationLevel } from "@chatter/core/notifications";
import { phaseOf } from "@chatter/core/eventTime";
import { NotificationSheet } from "./NotificationSheet";
import type { ComponentType } from "react";
import { displayUserId } from "@chatter/core/utils";
import { useChatter } from "@/state/ChatterProvider";
import { usePanels } from "./PanelLayout";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_META } from "@/ui/roles";

/**
 * The conversation's title bar — the web's phone header (ChatLayout's
 * MobileHeader): the menu, where you are (the room, and the channel under
 * it), the members. Below it, while the socket is down, the web's
 * "Connection lost" bar.
 *
 * Under it, the web's second row: notifications, events, pins, mentions,
 * search, and in a DM, adding people.
 * (Events join it when they arrive here.)
 */
export function ChatHeader() {
  const state = useChatter();
  const panels = usePanels();
  const insets = useSafeAreaInsets();
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);

  let title = room?.name ?? "Chatter";
  let subtitle = channel ? `#${channel.name}` : "";
  if (room?.is_direct) {
    const others = (room.dm_user_ids ?? []).filter((id) => id !== state.userId);
    const peer = others.length === 1 ? others[0] : null;
    title = (peer && (state.userPresence[peer]?.displayName || displayUserId(peer))) || room.name.replace(/^DM with /, "");
    subtitle = peer ? state.userPresence[peer]?.customStatus || "" : `${others.length + 1} members`;
  }

  return (
    <View style={{ paddingTop: insets.top }} className="bg-background">
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        {!panels.leftDocked && <HeaderButton icon={Menu} size={24} label="Open servers and channels" onPress={() => panels.show("left")} />}
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold" numberOfLines={1}>
            {title}
          </T>
          {subtitle ? (
            <T className={UI_META} numberOfLines={1}>
              {subtitle}
            </T>
          ) : null}
        </View>
        <HeaderButton icon={Users} size={24} label="Members" active={panels.rightVisible} onPress={panels.toggleRight} />
      </View>
      {state.currentRoomId ? <ToolRow /> : null}
      {!state.wsConnected && state.accessToken ? (
        <View className="flex-row items-center justify-center gap-2 bg-amber-600 px-3 py-1.5">
          <WifiOff size={16} color="#fff" />
          <T className="text-sm font-medium text-white">Connection lost — reconnecting…</T>
        </View>
      ) : null}
    </View>
  );
}

function HeaderButton({
  icon,
  size,
  label,
  active,
  onPress,
}: {
  icon: ComponentType<LucideProps>;
  size: number;
  label: string;
  active?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      className={cn("h-10 w-10 items-center justify-center rounded-lg active:bg-accent", active && "bg-accent")}
    >
      <Icon as={icon} size={size} tone={active ? "foreground" : "muted-foreground"} />
    </Pressable>
  );
}

const PHASE_TICK_MS = 30_000;

/** The web's tool row at phone width: right-aligned ghost icon buttons. */
function ToolRow() {
  const state = useChatter();
  const [bell, setBell] = useState(false);
  const roomId = state.currentRoomId!;
  const isDm = !!state.roomInfoMap[roomId]?.is_direct;
  const channelId = state.currentChannelId ?? undefined;
  const muted = resolveNotificationLevel(state.notificationSettings, roomId, channelId) === "none";
  // Green while something is on, primary for one starting soon (the web's).
  // The clock ticks on its own, so an event starts here without anything
  // else changing on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), PHASE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  let live = 0;
  let soon = 0;
  for (const event of state.roomEvents) {
    if (event.cancelled) continue;
    const phase = phaseOf(event, now);
    if (phase === "live") live++;
    else if (phase === "soon") soon++;
  }
  return (
    <View className="flex-row items-center justify-end gap-1 border-b border-border px-1 py-0.5">
      <Tool icon={muted ? BellOff : Bell} label="Notification settings" onPress={() => setBell(true)} />
      {!isDm ? (
        <Tool
          icon={CalendarDays}
          label={live > 0 ? `${live} event${live === 1 ? "" : "s"} happening now` : "Events"}
          dot={live > 0 ? "bg-success" : soon > 0 ? "bg-primary" : undefined}
          onPress={() => router.push("/events")}
        />
      ) : null}
      <Tool icon={Pin} label="Pinned messages" dot={state.pinnedMessages.length > 0 ? "bg-primary" : undefined} onPress={() => router.push({ pathname: "/panel", params: { mode: "pins" } })} />
      {!isDm ? <Tool icon={AtSign} label="Mentions" onPress={() => router.push({ pathname: "/panel", params: { mode: "mentions" } })} /> : null}
      <Tool icon={Search} label="Search" onPress={() => router.push({ pathname: "/panel", params: { mode: "search" } })} />
      {isDm ? <Tool icon={UserPlus} label="Add people" onPress={() => router.push({ pathname: "/people", params: { mode: "add" } })} /> : null}
      <NotificationSheet open={bell} onClose={() => setBell(false)} channelId={channelId} />
    </View>
  );
}

function Tool({ icon, label, dot, onPress }: { icon: ComponentType<LucideProps>; label: string; dot?: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="size-9 items-center justify-center rounded-md active:bg-accent">
      <Icon as={icon} size={17} tone="foreground" />
      {dot ? <View className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", dot)} /> : null}
    </Pressable>
  );
}
