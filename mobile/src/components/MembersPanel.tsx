import { useMemo } from "react";
import { SectionList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Crown, Shield, Smartphone } from "lucide-react-native";
import { senderNameColor } from "@chatter/core/messageFormat";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING } from "@/ui/roles";

/**
 * The room's members — the web's MembersPanel: a "MEMBERS n" heading, then
 * owners, moderators, members and the offline, each a section; a card on the
 * chat's background, as the drawer on the left.
 */
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
      // Anyone offline goes here, whatever their role.
      { title: "Offline", data: members.filter((m) => !online(m.userId)) },
    ];
    return groups.filter((g) => g.data.length > 0).map((g) => ({ ...g, offline: g.title === "Offline", title: `${g.title} — ${g.data.length}` }));
  }, [state.roomMembers, state.userPresence]);

  return (
    <View className="flex-1 bg-background px-2" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}>
      <View className="flex-1 overflow-hidden rounded-lg border border-border bg-sidebar">
        <View className="flex-row items-center gap-2 border-b border-border px-3 py-3">
          <T className={UI_HEADING}>Members</T>
          <View className="rounded-full bg-secondary px-2 py-0.5">
            <T className="text-xs font-medium text-secondary-foreground">{state.roomMembers.length}</T>
          </View>
        </View>
        <SectionList
          sections={sections}
          keyExtractor={(m) => m.userId}
          contentContainerClassName="p-2 gap-0.5"
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => <T className={cn(UI_HEADING, "px-2 pb-1 pt-3 text-3xs")}>{section.title}</T>}
          renderItem={({ item, section }) => {
            const p = state.userPresence[item.userId];
            const offline = section.offline;
            const color = senderNameColor(state, roomInfo, item.userId);
            return (
              <View className={cn("flex-row items-center gap-2 rounded-md px-2 py-1.5", offline && "opacity-50")}>
                <Avatar
                  userId={item.userId}
                  name={p?.displayName || item.displayName}
                  url={p?.avatarUrl}
                  size={40}
                  status={p?.status ?? "offline"}
                />
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-1">
                    <T
                      className={cn("shrink text-sm", offline && "text-muted-foreground")}
                      style={color && !offline ? { color } : undefined}
                      numberOfLines={1}
                    >
                      {p?.displayName || item.displayName}
                    </T>
                    {item.role === "owner" ? <Icon as={Crown} size={13} tone="warning" /> : null}
                    {item.role === "moderator" ? <Icon as={Shield} size={13} color="#60a5fa" /> : null}
                    {p?.isMobile && !offline ? <Icon as={Smartphone} size={13} tone="success" /> : null}
                  </View>
                  {p?.customStatus ? (
                    <T className="text-3xs leading-tight text-muted-foreground" numberOfLines={1}>
                      {p.customStatus}
                    </T>
                  ) : null}
                </View>
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}
