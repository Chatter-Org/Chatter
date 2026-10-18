import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu, Users, WifiOff, type LucideProps } from "lucide-react-native";
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
 * The web's second row (notifications, events, pins, mentions, search) joins
 * it as each of those arrives here.
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
    const peer = room.dm_user_ids?.find((id) => id !== state.userId);
    title = (peer && (state.userPresence[peer]?.displayName || displayUserId(peer))) || room.name.replace(/^DM with /, "");
    subtitle = (peer && state.userPresence[peer]?.customStatus) || "";
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
