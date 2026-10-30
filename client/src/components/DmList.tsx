import { useMemo, useState } from "react";
import { Check, LogOut, MoreVertical, UsersRound } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { resolveNotificationLevel, type NotificationLevel } from "@/lib/notifications";
import { GroupDMDialog } from "@/components/GroupDMDialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage, AuthImage } from "@/components/AuthImage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

const NOTIFICATION_LEVELS: { value: NotificationLevel; label: string }[] = [
  { value: "all", label: "All messages" },
  { value: "mentions", label: "Only @mentions" },
  { value: "none", label: "Nothing" },
];

/** The user's DMs, one row each, with the button that starts a group DM.
 *
 *  Drawn in two places: the DM column beside the chat on desktop, and the
 *  DMs tab of the mobile sidebar sheet. */
export function DmList({ onSelect }: { onSelect?: () => void }) {
  const { state } = useAppContext();
  const [groupDMDialogOpen, setGroupDMDialogOpen] = useState(false);
  // Streaks are judged against when the list was drawn; a day boundary
  // passing while it is open is picked up on the next mount.
  const [now] = useState(Date.now);

  const dmRoomIds = state.joinedRoomIds.filter((id) => state.roomInfoMap[id]?.is_direct);

  // Head-counts per room from the live voice state; the room's own
  // `dm_voice_count` answers until the socket has said anything.
  const liveVoice = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [channelId, members] of Object.entries(state.voiceChannelMembers)) {
      const roomId = state.voiceChannelRooms[channelId];
      if (roomId) counts[roomId] = (counts[roomId] ?? 0) + members.length;
    }
    return counts;
  }, [state.voiceChannelMembers, state.voiceChannelRooms]);

  return (
    <>
      <div className="px-2 pb-1">
        <button
          onClick={() => setGroupDMDialogOpen(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <UsersRound className="h-3 w-3" />
          Group DM
        </button>
      </div>
      {dmRoomIds.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          No direct messages yet
        </p>
      )}
      <div className="space-y-px px-2 pb-2">
        {dmRoomIds.map((roomId) => (
          <DmRow
            key={roomId}
            roomId={roomId}
            voiceCount={state.wsConnected ? (liveVoice[roomId] ?? 0) : undefined}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </div>
      <GroupDMDialog open={groupDMDialogOpen} onOpenChange={setGroupDMDialogOpen} />
    </>
  );
}

/** The DM list as a column of its own, in the slot a room's channel list
 *  takes. Rooms are made and joined from here: with the sidebar held to its
 *  rail, this is the one panel that is not about a particular room. */
export function DmColumn({
  onCreateRoom,
  onJoinRoom,
}: {
  onCreateRoom: () => void;
  onJoinRoom: () => void;
}) {
  return (
    <div className="flex h-full w-60 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={onCreateRoom}>
          + Create
        </Button>
        <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={onJoinRoom}>
          Join
        </Button>
      </div>
      <p className="ui-heading px-3 pt-3 pb-1.5">Direct messages</p>
      <ScrollArea className="flex-1 min-h-0">
        <DmList />
      </ScrollArea>
    </div>
  );
}

function DmRow({
  roomId,
  voiceCount: liveCount,
  now,
  onSelect,
}: {
  roomId: string;
  /** Undefined until the socket is up. */
  voiceCount: number | undefined;
  now: number;
  onSelect?: () => void;
}) {
  const confirm = useConfirm();
  const { state, selectRoom, leaveRoom, setNotificationLevel } = useAppContext();
  const notificationLevel = resolveNotificationLevel(state.notificationSettings, roomId);
  const info = state.roomInfoMap[roomId];
  const isActive = roomId === state.currentRoomId;
  const hasMention = !!state.roomMentions[roomId] && !isActive;
  const unreadCount = (!isActive && state.roomUnreadCounts[roomId]) || 0;
  const voiceCount = liveCount ?? info?.dm_voice_count ?? 0;

  const roomName = (info?.name || "Unnamed").replace(/^DM with /, "");
  const roomInitial = roomName.substring(0, 1).toUpperCase();

  // A one-to-one DM shows the other person's face. A group has no single
  // face to show, so it keeps the conversation glyph.
  // Self is filtered out server-side, and again here: a DM that listed both
  // members would have two ids, no single peer, and would silently fall back
  // to the glyph — a failure that looks exactly like the field being absent.
  const dmUserIds = (info?.dm_user_ids ?? []).filter((id) => id !== state.userId);
  const dmPeerId = dmUserIds.length === 1 ? dmUserIds[0] : null;
  // Presence first — it follows an avatar change live — then the copy that
  // came down with the room, which is there before the DM is ever opened.
  const dmPeerAvatar = dmPeerId
    ? (state.userPresence[dmPeerId]?.avatarUrl || info?.dm_avatars?.[dmPeerId] || "")
    : "";

  const streakCount = info?.dm_streak_count ?? 0;
  const lastTs = info?.dm_streak_last_ts ?? 0;
  const lastDay = lastTs > 0 ? Math.floor(lastTs / 86400000) : 0;
  const streakDeadline = lastTs > 0 ? (lastDay + 2) * 86400000 : 0;
  const isStreakAlive = lastTs > 0 && now < streakDeadline;
  const isStreakExpiring = isStreakAlive && (streakDeadline - now) < 4 * 3600 * 1000;
  const showStreak = streakCount >= 2 && isStreakAlive;

  return (
    <button
      onClick={() => {
        selectRoom(roomId);
        onSelect?.();
      }}
      title={roomName}
      className={cn(
        "group/card relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-3 pr-1.5 text-left transition-colors cursor-pointer",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 -translate-y-1/2 transition-all",
          isActive
            ? "left-0 h-5 w-0.5 rounded-r-full bg-sidebar-primary"
            : unreadCount > 0 || hasMention
              ? "left-1 size-1.5 rounded-full bg-sidebar-foreground"
              : "left-0 h-0 w-0.5 bg-transparent",
        )}
      />
      {info?.icon_url ? (
        <AuthImage
          src={info.icon_url}
          alt=""
          className="h-9 w-9 shrink-0 rounded-md object-cover"
        />
      ) : dmPeerAvatar && !showStreak ? (
        // Radix's Avatar so a deleted or unreachable file falls back to the
        // initial instead of a broken image.
        <Avatar className="h-9 w-9 shrink-0">
          <AuthAvatarImage src={dmPeerAvatar} />
          <AvatarFallback
            className={cn(
              "rounded-full text-sm font-bold",
              isActive
                ? "bg-sidebar-primary text-sidebar-primary-foreground"
                : "bg-sidebar-accent text-sidebar-foreground",
            )}
          >
            {roomInitial}
          </AvatarFallback>
        </Avatar>
      ) : (
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-bold",
            isActive
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "bg-sidebar-accent text-sidebar-foreground",
          )}
        >
          {showStreak ? (
            <span className="flex flex-col items-center leading-none">
              <span className="text-xs leading-none">{isStreakExpiring ? "⏳" : "🔥"}</span>
              <span className="text-3xs font-bold leading-none">{streakCount}</span>
            </span>
          ) : dmPeerId ? (
            roomInitial
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.678 11.894a1 1 0 0 1 .287.801 10.97 10.97 0 0 1-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 0 1 .71-.074A8.06 8.06 0 0 0 8 14c3.996 0 7-2.807 7-6s-3.004-6-7-6-7 2.808-7 6c0 1.468.617 2.83 1.678 3.894z" />
            </svg>
          )}
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium leading-tight">{roomName}</span>

      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {voiceCount > 0 && (
          <span className="text-success" title={`${voiceCount} in voice`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06z" />
              <path d="M8.707 11.182A4.486 4.486 0 0 0 10.025 8a4.486 4.486 0 0 0-1.318-3.182L8 5.525A3.489 3.489 0 0 1 9.025 8 3.49 3.49 0 0 1 8 10.475l.707.707z" />
              <path d="M10.121 12.596A6.48 6.48 0 0 0 12.025 8a6.48 6.48 0 0 0-1.904-4.596l-.707.707A5.483 5.483 0 0 1 11.025 8a5.483 5.483 0 0 1-1.61 3.89l.706.706z" />
            </svg>
          </span>
        )}
        {hasMention ? (
          <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-destructive px-1 text-3xs font-bold leading-none text-white">
            {state.roomMentions[roomId] > 99 ? "99+" : state.roomMentions[roomId]}
          </span>
        ) : unreadCount > 0 ? (
          <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-sidebar-primary px-1 text-3xs font-bold leading-none text-sidebar-primary-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </span>

      <span
        className="shrink-0 -mr-0.5 can-hover:hidden can-hover:group-hover/card:block"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label={`Options for ${roomName}`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="ui-heading">Notifications</DropdownMenuLabel>
            {NOTIFICATION_LEVELS.map(({ value, label }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => void setNotificationLevel(roomId, value).catch(() => {})}
              >
                <span className="w-4 flex justify-center">
                  {notificationLevel === value && <Check className="h-3.5 w-3.5" />}
                </span>
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={async () => {
                if (await confirm({ title: "Leave this conversation?", confirmLabel: "Leave", destructive: true })) {
                  leaveRoom(roomId);
                }
              }}
            >
              <LogOut className="h-3.5 w-3.5 mr-2" /> Leave
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </button>
  );
}
