import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AtSign, Hash, Menu, Users } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter } from "@/state/ChatterProvider";
import { usePanels } from "./PanelLayout";
import { Icon, T } from "@/ui/primitives";

/** The conversation's title bar: what is open, and the way to the panels. */
export function ChatHeader() {
  const state = useChatter();
  const panels = usePanels();
  const insets = useSafeAreaInsets();
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);

  let title = room?.name ?? "Chatter";
  let subtitle = room?.topic ?? "";
  if (room?.is_direct) {
    const peer = room.dm_user_ids?.find((id) => id !== state.userId);
    title = (peer && (state.userPresence[peer]?.displayName || displayUserId(peer))) || room.name;
    subtitle = peer ? state.userPresence[peer]?.customStatus ?? "" : "";
  } else if (channel) {
    title = channel.name;
    subtitle = channel.topic || room?.name || "";
  }

  return (
    <View style={{ paddingTop: insets.top }} className="border-b border-border bg-background">
      <View className="h-14 flex-row items-center gap-1 px-1">
        {!panels.leftDocked && (
          <Pressable onPress={() => panels.show("left")} hitSlop={6} accessibilityLabel="Open servers and channels" className="h-11 w-11 items-center justify-center rounded-full active:bg-accent">
            <Icon as={Menu} tone="foreground" size={22} />
          </Pressable>
        )}
        <View className="flex-1 flex-row items-center gap-1.5 px-1">
          <Icon as={room?.is_direct ? AtSign : Hash} size={18} />
          <View className="flex-1">
            <T className="font-mono-bold text-base" numberOfLines={1}>
              {title}
            </T>
            {subtitle ? (
              <T className="text-[11px] text-muted-foreground" numberOfLines={1}>
                {subtitle}
              </T>
            ) : null}
          </View>
        </View>
        {!state.wsConnected && state.accessToken ? (
          <View className="mr-1 rounded-full bg-warning/20 px-2 py-0.5">
            <T className="text-[10px] text-warning">reconnecting</T>
          </View>
        ) : null}
        <Pressable onPress={panels.toggleRight} hitSlop={6} accessibilityLabel="Members" className="h-11 w-11 items-center justify-center rounded-full active:bg-accent">
          <Icon as={Users} tone={panels.rightVisible ? "foreground" : "muted-foreground"} size={20} />
        </Pressable>
      </View>
    </View>
  );
}
