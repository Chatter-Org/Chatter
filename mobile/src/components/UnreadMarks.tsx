import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { oldestUnreadEventId } from "@chatter/core/unreads";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { T } from "@/ui/primitives";

/**
 * Where you left off, as the web's ChatArea marks it: a red "New" line above
 * the oldest message you had not read when you opened the channel, and on
 * opening a room with unreads elsewhere in it, a bar that takes you to where
 * the conversation went on.
 */

/**
 * The message the "New" line goes above, for the channel on screen.
 *
 * The unread count is taken as the channel opens (and its badge cleared
 * then); the line goes in once the messages it counts have loaded, and stays
 * until the reader leaves the channel.
 */
export function useNewDivider(): string | null {
  const state = useChatter();
  const { clearUnread, markChannelRead } = useChatterActions();
  const [firstUnread, setFirstUnread] = useState<string | null>(null);
  const pending = useRef(0);
  const scope = useRef("");

  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId;

  useEffect(() => {
    const next = `${roomId ?? ""}|${channelId ?? ""}`;
    if (next === scope.current) return;
    scope.current = next;
    setFirstUnread(null);
    pending.current = 0;
    if (!roomId) return;
    // A DM's unreads are the room's own bucket, not a channel's.
    const count = channelId
      ? state.channelUnreadCounts[channelId] || 0
      : state.roomInfoMap[roomId]?.is_direct
        ? state.roomLooseUnreads[roomId] || 0
        : 0;
    markChannelRead(roomId, channelId ?? undefined);
    if (count > 0) {
      pending.current = count;
      clearUnread(roomId, channelId);
    }
    // Read from the state of the moment the channel opened, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, channelId]);

  // Not loaded yet: stay pending, so loading back far enough places it then.
  useEffect(() => {
    if (!pending.current || state.messages.length === 0) return;
    const found = oldestUnreadEventId(state.messages, pending.current, state.userId);
    if (found) {
      setFirstUnread(found);
      pending.current = 0;
    }
  }, [state.messages, state.userId]);

  return firstUnread;
}

/** The web's "New" line: red, the word at the right. */
export function NewDivider() {
  return (
    <View className="flex-row items-center gap-2 px-2 py-1.5" accessibilityRole="text" accessibilityLabel="New messages below">
      <View className="h-px flex-1 bg-destructive/40" />
      <T className="text-2xs font-semibold uppercase tracking-wide text-destructive/70">New</T>
    </View>
  );
}

/**
 * The bar on opening a room with unreads: "n unread messages since your last
 * visit". Its text takes you to the channel whose newest unread is the most
 * recent; "Read" puts it away.
 */
export function UnreadBanner() {
  const state = useChatter();
  const { selectChannel } = useChatterActions();
  const [count, setCount] = useState(0);
  const room = useRef<string | null>(null);

  useEffect(() => {
    if (state.currentRoomId === room.current) return;
    room.current = state.currentRoomId;
    setCount(state.currentRoomId ? state.roomUnreadCounts[state.currentRoomId] || 0 : 0);
    // Captured as the room opens, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentRoomId]);

  if (count <= 0) return null;

  const jump = () => {
    let best: string | null = null;
    let bestTs = -1;
    for (const ch of state.channels) {
      if (ch.channel_type !== "text" || (state.channelUnreadCounts[ch.channel_id] || 0) <= 0) continue;
      const ts = state.channelLatestUnreadTs[ch.channel_id] || 0;
      if (ts > bestTs) {
        bestTs = ts;
        best = ch.channel_id;
      }
    }
    setCount(0);
    if (best && best !== state.currentChannelId) void selectChannel(best).catch(() => {});
  };

  return (
    <View className="flex-row items-center justify-between bg-info px-4 py-2">
      <Pressable onPress={jump} accessibilityRole="button" accessibilityHint="Goes to the most recent unread message" className="flex-1">
        <T className="text-sm font-medium text-background">
          {count} unread message{count !== 1 ? "s" : ""} since your last visit
        </T>
      </Pressable>
      <Pressable
        onPress={() => setCount(0)}
        accessibilityRole="button"
        className="ml-4 rounded border border-background/30 px-2 py-0.5 active:border-background/60"
      >
        <T className="text-xs text-background/90">Read</T>
      </Pressable>
    </View>
  );
}
