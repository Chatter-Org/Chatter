import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Clock, Crown, Shield, Smartphone, Gamepad2 } from "lucide-react";
import { formatTimeoutEnd } from "@/components/moderation/moderationUtils";
import { useAppContext } from "@/lib/store";
import { useReadableColor } from "@/lib/theme";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "./AuthImage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { profileWashStyle, readProfileTheme } from "@/lib/profileTheme";
import { memberCanViewChannel } from "@/lib/permissions";
import { groupMembers } from "@chatter/core/memberGroups";
import { ensureFontFace } from "@/lib/fontFace";
import { UserProfileDialog } from "./UserProfileDialog";
import { ScreenPeek } from "./voice/ScreenPeek";

interface MembersPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function MembersPanel({ collapsed, onToggle }: MembersPanelProps) {
  const { state } = useAppContext();
  const readable = useReadableColor();
  const [profileOpen, setProfileOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);

  const roomInfo = state.currentRoomId
    ? state.roomInfoMap[state.currentRoomId]
    : null;

  const { customRoles, memberCustomRoles } = state;
  // With a thread open the list is the thread's: whoever has posted in it —
  // the root's author and everyone who replied. Not `thread_participants`,
  // which also holds people who were only named or answered. The replies are
  // loaded a page at a time, so the server names every poster on opening and
  // `ADD_THREAD_MESSAGE` keeps that live as the thread grows.
  const threadPosters = useMemo(() => {
    if (!state.activeThreadEventId || !state.threadRootMessage) return null;
    return new Set<string>([state.threadRootMessage.sender, ...state.threadPosters]);
  }, [state.activeThreadEventId, state.threadRootMessage, state.threadPosters]);

  const groups = useMemo(() => {
    const currentChannel = state.channels.find((c) => c.channel_id === state.currentChannelId);
    const roles = { customRoles, memberCustomRoles };
    const visible = state.roomMembers.filter(
      (m) =>
        (!threadPosters || threadPosters.has(m.userId)) &&
        // Hide members who cannot see this channel under its overwrites.
        memberCanViewChannel(roles, currentChannel, m),
    );
    const online = (id: string) => (state.userPresence[id]?.status || "offline") !== "offline";
    return groupMembers(visible, online, customRoles, memberCustomRoles);
  }, [state.roomMembers, state.channels, state.currentChannelId, state.userPresence, customRoles, memberCustomRoles, threadPosters]);

  if (!state.currentRoomId) return null;

  if (collapsed) {
    return (
      <div className="w-8 border-l flex flex-col items-center pt-3 shrink-0">
        <button
          onClick={onToggle}
          title="Show members"
          className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const renderMember = (member: (typeof state.roomMembers)[0]) => {
    const presence = state.userPresence[member.userId];
    const status = presence?.status || "offline";
    const customStatus = presence?.customStatus;
    const effectiveName = presence?.displayName || member.displayName;
    const initial = effectiveName[0]?.toUpperCase() || "?";

    // Role color: first custom role with a color wins as fallback
    const userRoleIds = state.memberCustomRoles[member.userId] || [];
    const topRoleColor = userRoleIds.reduce<string | undefined>((acc, rid) => {
      if (acc) return acc;
      const r = state.customRoles.find((cr) => cr.role_id === rid);
      return r?.color || acc;
    }, undefined);

    const nameColor = readable(
      member.role === "owner" && roomInfo?.owner_name_color
        ? roomInfo.owner_name_color
        : member.role === "moderator" && roomInfo?.mod_name_color
          ? roomInfo.mod_name_color
          : topRoleColor,
    );

    const nameFontUrl = presence?.nameFontUrl;
    if (nameFontUrl) {
      ensureFontFace(member.userId, nameFontUrl);
    }

    // The tab's own colours, set separately from the modal's — a strip beside
    // dozens of others wants something quieter than a card usually does.
    const wash = profileWashStyle(readProfileTheme(presence), "tab");

    // Hovering a member sharing in a call the viewer is not in shows a still of
    // their screen; `ScreenPeek` draws nothing for anyone else.
    return (
      <ScreenPeek key={member.userId} userId={member.userId} name={effectiveName} side="left">
      <div
        onClick={() => {
          setSelectedMember({ ...member, displayName: effectiveName });
          setProfileOpen(true);
        }}
        className={cn(
          "group relative flex items-center gap-2.5 rounded-md px-2 py-1 transition-colors cursor-pointer hover:bg-accent/50",
          status === "offline" && "opacity-45 hover:opacity-80"
        )}
        style={wash}
      >
        <div className="relative flex-shrink-0">
          <Avatar className="h-8 w-8">
            <AuthAvatarImage src={presence?.avatarUrl} />
            <AvatarFallback className="text-xs bg-secondary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background",
              (status === "active" || status === "online") && "bg-success",
              (status === "idle" || status === "away") && "bg-warning",
              status === "dnd" && "bg-destructive",
              status === "offline" && "bg-muted-foreground"
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span
              className={cn(
                "truncate text-sm font-medium block",
                status === "offline" && "text-muted-foreground"
              )}
              style={{
                ...(nameColor ? { color: nameColor } : {}),
                ...(nameFontUrl ? { fontFamily: `'user-font-${CSS.escape(member.userId)}'` } : {}),
              }}
            >
              {effectiveName}
            </span>
            {member.role === "owner" && (
              <Crown className="h-3 w-3 text-warning shrink-0" />
            )}
            {member.role === "moderator" && (
              <Shield className="h-3 w-3 text-blue-400 shrink-0" />
            )}
            {!!member.timeoutUntil && (
              <span title={`Timed out until ${formatTimeoutEnd(member.timeoutUntil)}`} className="shrink-0">
                <Clock className="h-3 w-3 text-orange-400" />
              </span>
            )}
            {presence?.isMobile && status !== "offline" && (
              <Smartphone className="h-3 w-3 text-success shrink-0" />
            )}
          </span>
          {customStatus && (
            <span className="truncate text-2xs leading-tight text-muted-foreground block">
              {customStatus}
            </span>
          )}
          {presence?.steamGame && status !== "offline" && (
            <span className="flex items-center gap-1 text-2xs leading-tight text-info overflow-hidden">
              <Gamepad2 className="h-3 w-3 shrink-0" />
              <span className="overflow-hidden">
                <span
                  className="block whitespace-nowrap"
                  style={{ animation: `marquee-loop ${Math.max(4, presence.steamGame.length * 0.18)}s linear infinite` }}
                >
                  {presence.steamGame}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{presence.steamGame}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
                </span>
              </span>
            </span>
          )}
        </div>
      </div>
      </ScreenPeek>
    );
  };

  const renderSection = (key: string, label: string, items: typeof state.roomMembers) => (
    <div key={key}>
      <p className="ui-heading px-2 pt-4 pb-1">
        {label} — {items.length}
      </p>
      {items.map(renderMember)}
    </div>
  );

  return (
    <div className="w-full md:w-60 md:border-l flex flex-col shrink-0 h-full">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <h3 className="ui-heading">
          {threadPosters ? "In this thread" : "Members"}
        </h3>
        <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-3xs font-semibold tabular-nums">
          {groups.reduce((n, g) => n + g.members.length, 0)}
        </span>
        <button
          onClick={onToggle}
          title="Hide members"
          className="ml-auto h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <ScrollArea className="flex-1 min-h-0 p-2">
        <div className="space-y-0.5">
          {groups.map((g) => renderSection(g.key, g.label, g.members))}
        </div>
      </ScrollArea>

      {selectedMember && (
        <UserProfileDialog
          open={profileOpen}
          onOpenChange={setProfileOpen}
          userId={selectedMember.userId}
          displayName={selectedMember.displayName}
        />
      )}
    </div>
  );
}
