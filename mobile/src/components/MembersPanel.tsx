import { useMemo } from "react";
import { Pressable, SectionList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Crown, Shield, Smartphone } from "lucide-react-native";
import { senderNameColor } from "@chatter/core/messageFormat";
import { groupMembers } from "@chatter/core/memberGroups";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { useShowProfile } from "./ProfileSheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING } from "@/ui/roles";
import { NameText } from "./NameText";

/**
 * The room's members — the web's MembersPanel: a "MEMBERS n" heading, then
 * owners, moderators, each role shown separately, members and the offline,
 * each a section; a card on the chat's background, as the drawer on the left.
 */
export function MembersPanel() {
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const showProfile = useShowProfile();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;

  const sections = useMemo(() => {
    const online = (id: string) => {
      const s = state.userPresence[id]?.status;
      return !!s && s !== "offline";
    };
    const byName = (a: { displayName: string }, b: { displayName: string }) => a.displayName.localeCompare(b.displayName);
    const members = [...state.roomMembers].sort(byName);
    return groupMembers(members, online, state.customRoles, state.memberCustomRoles).map((g) => ({
      key: g.key,
      data: g.members,
      offline: g.key === "offline",
      title: `${g.label} — ${g.members.length}`,
    }));
  }, [state.roomMembers, state.userPresence, state.customRoles, state.memberCustomRoles]);

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
              <Pressable
                onPress={() => showProfile(item.userId)}
                accessibilityRole="button"
                className={cn("flex-row items-center gap-2 rounded-md px-2 py-1.5 active:bg-sidebar-accent/50", offline && "opacity-50")}
              >
                <Avatar
                  userId={item.userId}
                  name={p?.displayName || item.displayName}
                  url={p?.avatarUrl}
                  size={40}
                  status={p?.status ?? "offline"}
                />
                <View className="min-w-0 flex-1">
                  <View className="flex-row items-center gap-1">
                    <NameText
                      fontUrl={p?.nameFontUrl}
                      className={cn("shrink text-sm", offline && "text-muted-foreground")}
                      style={color && !offline ? { color } : undefined}
                      numberOfLines={1}
                    >
                      {p?.displayName || item.displayName}
                    </NameText>
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
              </Pressable>
            );
          }}
        />
      </View>
    </View>
  );
}
