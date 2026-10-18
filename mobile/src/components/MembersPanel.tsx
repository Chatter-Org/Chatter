import { useMemo } from "react";
import { SectionList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Crown, Smartphone } from "lucide-react-native";
import { senderNameColor } from "@chatter/core/messageFormat";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";

/** The room's members, grouped as on the web: owners, moderators, members, offline. */
export function MembersPanel() {
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;

  const sections = useMemo(() => {
    const online = (id: string) => {
      const s = state.userPresence[id]?.status;
      return !!s && s !== "offline";
    };
    const byName = (a: { displayName: string }, b: { displayName: string }) => a.displayName.localeCompare(b.displayName);
    const members = [...state.roomMembers].sort(byName);
    const groups = [
      { title: "Owner", data: members.filter((m) => m.role === "owner" && online(m.userId)) },
      { title: "Moderators", data: members.filter((m) => m.role === "moderator" && online(m.userId)) },
      { title: "Members", data: members.filter((m) => m.role !== "owner" && m.role !== "moderator" && online(m.userId)) },
      { title: "Offline", data: members.filter((m) => !online(m.userId)) },
    ];
    return groups.filter((g) => g.data.length > 0).map((g) => ({ ...g, title: `${g.title} — ${g.data.length}` }));
  }, [state.roomMembers, state.userPresence]);

  return (
    <View className="flex-1 bg-sidebar" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom }}>
      <T className="px-4 pb-2 text-[11px] uppercase tracking-widest text-muted-foreground">Members {state.roomMembers.length}</T>
      <SectionList
        sections={sections}
        keyExtractor={(m) => m.userId}
        contentContainerClassName="px-2 pb-4"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <T className="mt-3 mb-1 px-2 text-[11px] uppercase tracking-widest text-muted-foreground">{section.title}</T>}
        renderItem={({ item, section }) => {
          const p = state.userPresence[item.userId];
          const offline = section.title.startsWith("Offline");
          const color = senderNameColor(state, roomInfo, item.userId);
          return (
            <View className={cn("flex-row items-center gap-3 rounded-lg px-2 py-1.5", offline && "opacity-50")}>
              <Avatar userId={item.userId} name={p?.displayName || item.displayName} url={p?.avatarUrl} size={34} status={offline ? undefined : p?.status} />
              <View className="flex-1">
                <View className="flex-row items-center gap-1">
                  <T className="font-mono-medium" style={color ? { color } : undefined} numberOfLines={1}>
                    {p?.displayName || item.displayName}
                  </T>
                  {item.role === "owner" && <Icon as={Crown} size={13} tone="warning" />}
                  {p?.isMobile && !offline && <Icon as={Smartphone} size={12} />}
                </View>
                {p?.customStatus ? (
                  <T className="text-[11px] text-muted-foreground" numberOfLines={1}>
                    {p.customStatus}
                  </T>
                ) : null}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
