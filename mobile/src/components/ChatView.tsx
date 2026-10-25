import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { usePanels } from "./PanelLayout";
import { useWindowLayout } from "@/ui/windowLayout";
import { ActivityIndicator, AppState, Pressable, View, type ScrollViewProps } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { KeyboardChatScrollView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ArrowDown } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { groupsWith, startsNewDay } from "@chatter/core/messageFormat";
import { oldestUnreadEventId } from "@chatter/core/unreads";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { MessageRow } from "./MessageRow";
import { MessageActions } from "./MessageActions";
import { Composer } from "./Composer";
import { RestrictionBar, isRestricted } from "./RestrictionBar";
import { CallBar } from "./CallBar";
import { NewDivider, UnreadBanner, useNewDivider } from "./UnreadMarks";
import { useMessageRows } from "./useMessageRows";
import { Icon, T } from "@/ui/primitives";
import { showToast } from "@/platform/toast";

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string }
  | { kind: "message"; key: string; message: MatrixMessage; grouped: boolean };

/** Where each conversation was left, for as long as the app runs: the message
 *  at the top of the screen, keyed "room|channel". None means the bottom. */
const leftAt = new Map<string, string>();

const ChatScroll = forwardRef<any, ScrollViewProps>(function ChatScroll(props, ref) {
  return <KeyboardChatScrollView ref={ref} {...props} keyboardLiftBehavior="always" />;
});

/** The open conversation: its timeline and, under it, the composer. */
export function ChatView() {
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const inCall = state.inVoiceChannel;
  const [callBarHeight, setCallBarHeight] = useState(0);
  const keyboard = useReanimatedKeyboardAnimation();
  const below = inCall ? callBarHeight : insets.bottom;
  const composerLift = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.min(0, keyboard.height.value + below) }],
  }));
  const listRef = useRef<FlashListRef<Row>>(null);
  const rootRef = useRef<ComponentRef<typeof View>>(null);
  const [topInWindow, setTopInWindow] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MatrixMessage | null>(null);
  const [acting, setActing] = useState<MatrixMessage | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId;
  const scope = `${roomId ?? ""}|${channelId ?? ""}`;

  const { firstUnread, unreadAtOpen } = useNewDivider();
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    state.messages.forEach((message, i) => {
      const prev = state.messages[i - 1];
      if (startsNewDay(prev, message)) {
        const d = new Date(message.origin_server_ts);
        out.push({
          kind: "day",
          key: `day-${d.toDateString()}`,
          label: d.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
          }),
        });
      }
      const isFirstUnread = message.event_id === firstUnread;
      if (isFirstUnread) out.push({ kind: "new", key: `new-${message.event_id}` });
      out.push({
        kind: "message",
        key: message.event_id,
        message,
        // The line breaks the group: what follows it starts fresh.
        grouped: groupsWith(prev, message) && !startsNewDay(prev, message) && !isFirstUnread,
      });
    });
    return out;
  }, [state.messages, firstUnread]);

  // Where a conversation opens, decided once its messages are here, as on
  // Discord: at the "New" line if anything came in while you were away (or
  // at the oldest loaded message, when more came in than is loaded);
  // otherwise where you left it; otherwise at the newest. The list is mounted
  // afresh for each conversation from that moment, so it starts there rather
  // than where the last one's scroll left it — which was near the top, and
  // reaching the top loaded a page of older history on every switch.
  const [landing, setLanding] = useState<{ scope: string; index: number | null } | null>(null);
  if (rows.length > 0 && landing?.scope !== scope) {
    const indexOf = (eventId: string | null | undefined) =>
      eventId ? rows.findIndex((r) => r.kind === "message" && r.message.event_id === eventId) : -1;
    let index: number | null = null;
    if (state.pendingJump?.roomId === roomId) {
      // The jump below takes it from the bottom.
    } else if (unreadAtOpen > 0) {
      const at = indexOf(firstUnread ?? oldestUnreadEventId(state.messages, unreadAtOpen, state.userId));
      // A row of what came before it, for context.
      index = at >= 0 ? Math.max(0, at - 1) : 0;
    } else {
      const at = indexOf(leftAt.get(scope));
      if (at >= 0) index = at;
    }
    setLanding({ scope, index });
    setAtBottom(index === null);
  }
  const landed = landing?.scope === scope ? landing : null;

  // The top message on screen, remembered as where this conversation was
  // left whenever the reader is somewhere other than the bottom.
  const topOnScreen = useRef<{ scope: string; eventId: string } | null>(null);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: Row; index: number | null }[] }) => {
      let top: { item: Row; index: number | null } | undefined;
      for (const v of viewableItems) {
        if (v.item.kind === "message" && (top === undefined || (v.index ?? 0) < (top.index ?? 0))) top = v;
      }
      if (top?.item.kind === "message") topOnScreen.current = { scope, eventId: top.item.message.event_id };
    },
    [scope],
  );

  const { rowData, nameOf } = useMessageRows();
  const panels = usePanels();

  // A thread opens beside the conversation where there is room for it, and
  // as a screen of its own over it on a phone.
  const openThread = useCallback(
    (eventId: string) => {
      void actions.openThread(eventId).catch(() => showToast({ message: "Couldn't open the thread", tone: "error" }));
      // Beside the conversation where there is room; over it on a phone.
      if (panels.threadBeside) panels.openThread();
      else router.push("/thread");
    },
    [actions, panels],
  );

  // The channel's pins, for the header's pin dot and the pins screen.
  useEffect(() => {
    if (roomId) void actions.loadPins();
  }, [roomId, channelId, actions]);

  // What the reader has seen is read: the newest message, while they are at
  // the bottom of the conversation with the app in front of them.
  const newest = state.messages[state.messages.length - 1]?.event_id;
  useEffect(() => {
    if (!roomId || !atBottom || AppState.currentState !== "active") return;
    actions.markChannelRead(roomId, channelId ?? undefined);
  }, [roomId, channelId, newest, atBottom, actions]);

  // Something you posted — a message, a poll — is something you want to see:
  // follow it down wherever the reader was.
  const newestMessage = state.messages[state.messages.length - 1];
  const lastFollowed = useRef(newest);
  useEffect(() => {
    if (!newest || newest === lastFollowed.current) return;
    // Only an arrival at the end: a channel switch or a jump also changes the
    // newest message, and must not be pulled away from.
    const appended = state.messages[state.messages.length - 2]?.event_id === lastFollowed.current;
    lastFollowed.current = newest;
    if (appended && newestMessage?.sender === state.userId) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [newest, newestMessage, state.messages, state.userId]);

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "new") return <NewDivider />;
      if (item.kind === "day") {
        return (
          // The web's day divider: a line either side of a pill.
          <View className="flex-row items-center justify-center gap-2 px-2 py-1.5">
            <View className="h-px flex-1 bg-border" />
            <View className="rounded-full bg-muted/40 px-2 py-0.5">
              <T className="text-xs font-medium text-muted-foreground/70">{item.label}</T>
            </View>
            <View className="h-px flex-1 bg-border" />
          </View>
        );
      }
      const m = item.message;
      return (
        <MessageRow
          {...rowData(m)}
          message={m}
          grouped={item.grouped}
          highlighted={m.event_id === highlighted}
          onReply={setReplyTo}
          onLongPress={setActing}
          onOpenThread={openThread}
        />
      );
    },
    [rowData, highlighted, openThread],
  );

  // A jump to a message — a message link opened, from here or another room
  // (openMessage). Go to its channel, load around it if it is not here, then
  // scroll to it and light it up for a moment, as the web does.
  const jump = state.pendingJump;
  const loadedAround = useRef<string | null>(null);
  useEffect(() => {
    if (!jump || jump.roomId !== roomId) return;
    if (jump.channelId && jump.channelId !== channelId) {
      void actions.selectChannel(jump.channelId).catch(() => actions.clearPendingJump());
      return;
    }
    // Wait for this channel's own messages, not the last one's still on screen.
    const last = state.messages[state.messages.length - 1];
    if (!last || (jump.channelId && last.channel_id && last.channel_id !== jump.channelId)) return;
    const index = rows.findIndex((r) => r.kind === "message" && r.message.event_id === jump.eventId);
    if (index >= 0) {
      // The light comes on with the scroll that brings it into view.
      requestAnimationFrame(() => {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
        setHighlighted(jump.eventId);
      });
      setTimeout(() => setHighlighted((h) => (h === jump.eventId ? null : h)), 1500);
      loadedAround.current = null;
      actions.clearPendingJump();
      return;
    }
    if (loadedAround.current !== jump.eventId) {
      loadedAround.current = jump.eventId;
      void actions.loadMessagesAround(jump.roomId, jump.ts).catch(() => actions.clearPendingJump());
      return;
    }
    // Loaded around it and still not here: gone, or not ours to see.
    loadedAround.current = null;
    actions.clearPendingJump();
  }, [jump, roomId, channelId, rows, state.messages, actions]);

  // A foldable half open like a laptop (useWindowLayout): the list ends at
  // the hinge, wherever this view starts in the window.
  const { tabletop } = useWindowLayout();
  const tabletopListHeight = tabletop && topInWindow !== null ? Math.max(160, tabletop.y - topInWindow) : null;

  if (!roomId) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <T className="text-center text-muted-foreground">
          {panels.leftDocked ? "Pick a server or a conversation." : "Swipe right to pick a server or a conversation."}
        </T>
      </View>
    );
  }

  return (
    <View
      className="flex-1"
      ref={rootRef}
      onLayout={() => rootRef.current?.measureInWindow((_x, y) => setTopInWindow(y))}
    >
      <UnreadBanner />
      {/* Tabletop: the messages stand on the top half, above the hinge. */}
      <View style={tabletopListHeight !== null ? { height: tabletopListHeight } : { flex: 1 }}>
      {landed ? (
      <FlashList
        key={landed.scope}
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.kind === "message" ? (row.grouped ? "grouped" : "full") : row.kind)}
        renderItem={renderItem}
        renderScrollComponent={ChatScroll}
        initialScrollIndex={landed.index ?? undefined}
        // Following new messages down only from the bottom: opened higher up, the
        // list stays put until the reader gets there.
        maintainVisibleContentPosition={{
          startRenderingFromBottom: landed.index === null,
          autoscrollToBottomThreshold: landed.index === null || atBottom ? 0.2 : undefined,
        }}
        onStartReached={() => void actions.loadOlderMessages()}
        onStartReachedThreshold={0.5}
        onScroll={(e) => {
          // Until the list has shown its first rows it is still settling into
          // place, and reports itself at the bottom before it has measured
          // anything: that would forget where the reader left off, and have
          // the list follow the newest message down from there.
          if (topOnScreen.current?.scope !== scope) return;
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          setAtBottom(fromBottom < 80);
          if (fromBottom < 80) leftAt.delete(scope);
          else leftAt.set(scope, topOnScreen.current.eventId);
        }}
        onViewableItemsChanged={onViewableItemsChanged}
        scrollEventThrottle={100}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          state.loadingOlderMessages ? (
            <ActivityIndicator className="py-3" />
          ) : !state.hasMoreMessages && state.messages.length > 0 ? (
            <T className="py-2 text-center text-xs text-muted-foreground">Beginning of conversation</T>
          ) : null
        }
        ListFooterComponent={<View style={{ height: 12 }} />}
      />
      ) : null}
      </View>
      {/* Below the hinge, the composer sits at the bottom of the lower half. */}
      {tabletopListHeight !== null ? <View className="flex-1 border-t border-border" /> : null}
      {!atBottom && (
        <Pressable
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          accessibilityLabel="Jump to newest"
          className="absolute bottom-24 right-5 h-9 w-9 items-center justify-center rounded-full border border-border bg-secondary opacity-90 shadow-lg"
        >
          <Icon as={ArrowDown} tone="secondary-foreground" size={17} />
        </Pressable>
      )}
      {/* The composer rides the keyboard; the call bar under it stays put, so
          the keyboard's lift is measured from the bar's top. Never lower than
          its resting place: a floating keyboard reports almost no height. */}
      <Animated.View style={composerLift}>
        <TypingLine names={state.typingUsers.filter((u) => u !== state.userId).map(nameOf)} />
        {isRestricted(state.myRestriction) ? (
          <RestrictionBar bottomInset={inCall ? 0 : insets.bottom} />
        ) : (
          <Composer
            key={`${roomId}|${channelId ?? ""}`}
            replyTo={replyTo}
            replyName={replyTo ? nameOf(replyTo.sender) : undefined}
            onClearReply={() => setReplyTo(null)}
            bottomInset={inCall ? 0 : insets.bottom}
          />
        )}
      </Animated.View>
      <CallBar bottomInset={insets.bottom} onHeight={setCallBarHeight} />
      <MessageActions message={acting} onClose={() => setActing(null)} onReply={setReplyTo} onOpenThread={openThread} />
    </View>
  );
}

/** Who is typing, in the web's words: a line over the bottom of the
 *  conversation while anyone is, rather than a strip kept empty above the
 *  composer the rest of the time. */
function TypingLine({ names }: { names: string[] }) {
  const text =
    names.length === 0
      ? ""
      : names.length === 1
        ? `${names[0]} is typing...`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing...`
          : names.length === 3
            ? `${names[0]}, ${names[1]}, and ${names[2]} are typing...`
            : "Multiple users are yapping....";
  if (!text) return null;
  return (
    <View className="absolute bottom-full left-0 right-0 h-5 flex-row items-center gap-1.5 bg-background/90 px-4" pointerEvents="none">
      <View className="flex-row gap-0.5">
        {[0, 1, 2].map((i) => (
          <View key={i} className="h-1 w-1 rounded-full bg-muted-foreground" />
        ))}
      </View>
      <T className="flex-1 text-xs italic text-muted-foreground" numberOfLines={1}>
        {text}
      </T>
    </View>
  );
}
