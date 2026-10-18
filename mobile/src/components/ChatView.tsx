import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, TextInput, View, type ScrollViewProps } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowDown, SendHorizontal, X } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { groupsWith, senderNameColor, startsNewDay, type FormatOptions } from "@chatter/core/messageFormat";
import { mentionRoleColors } from "@chatter/core/mentions";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { MessageRow } from "./MessageRow";
import { MessageActions } from "./MessageActions";
import { Composer } from "./Composer";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { useTheme } from "@/theme/ThemeProvider";
import { showToast } from "@/platform/toast";

type Row = { kind: "day"; key: string; label: string } | { kind: "message"; key: string; message: MatrixMessage; grouped: boolean };

const ChatScroll = forwardRef<any, ScrollViewProps>(function ChatScroll(props, ref) {
  return <KeyboardChatScrollView ref={ref} {...props} keyboardLiftBehavior="always" />;
});

/** The open conversation: its timeline and, under it, the composer. */
export function ChatView() {
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<Row>>(null);
  const [replyTo, setReplyTo] = useState<MatrixMessage | null>(null);
  const [acting, setActing] = useState<MatrixMessage | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId;
  const roomInfo = roomId ? state.roomInfoMap[roomId] : undefined;

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
      out.push({ kind: "message", key: message.event_id, message, grouped: groupsWith(prev, message) && !startsNewDay(prev, message) });
    });
    return out;
  }, [state.messages]);

  const formatOptions = useMemo<FormatOptions>(
    () => ({
      currentUserId: state.userId,
      roleColors: mentionRoleColors(state.customRoles, roomInfo),
      emojiAliases: Object.fromEntries(Object.entries(roomInfo?.emoji_aliases ?? {}).map(([alias, url]) => [url as string, alias])),
    }),
    [state.userId, state.customRoles, roomInfo],
  );

  const nameOf = useCallback(
    (userId: string) => state.userPresence[userId]?.displayName || state.roomMembers.find((m) => m.userId === userId)?.displayName || displayUserId(userId),
    [state.userPresence, state.roomMembers],
  );

  // What the reader has seen is read: the newest message, while they are at
  // the bottom of the conversation with the app in front of them.
  const newest = state.messages[state.messages.length - 1]?.event_id;
  useEffect(() => {
    if (!roomId || !atBottom || AppState.currentState !== "active") return;
    actions.markChannelRead(roomId, channelId ?? undefined);
  }, [roomId, channelId, newest, atBottom, actions]);

  const myName = state.userId ? displayUserId(state.userId).toLowerCase() : "";
  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
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
      const body = m.content.body ?? "";
      const mentionsMe =
        m.sender !== state.userId &&
        (m.content.reply_to_sender === state.userId || (!!myName && new RegExp(`@${myName}\\b`, "i").test(body)));
      return (
        <MessageRow
          message={m}
          grouped={item.grouped}
          senderName={nameOf(m.sender)}
          senderColor={senderNameColor(state, roomInfo, m.sender)}
          avatarUrl={state.userPresence[m.sender]?.avatarUrl}
          replySenderName={m.content.reply_to_sender ? nameOf(m.content.reply_to_sender) : undefined}
          reactions={state.messageReactions[m.event_id]}
          myUserId={state.userId}
          mentionsMe={mentionsMe}
          formatOptions={formatOptions}
          onReply={setReplyTo}
          onLongPress={setActing}
          onReact={actions.addReaction}
        />
      );
    },
    [state, roomInfo, formatOptions, nameOf, myName, actions.addReaction],
  );

  if (!roomId) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <T className="text-center text-muted-foreground">Swipe right to pick a server or a conversation.</T>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => (row.kind === "day" ? "day" : row.grouped ? "grouped" : "full")}
        renderItem={renderItem}
        renderScrollComponent={ChatScroll}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
        onStartReached={() => void actions.loadOlderMessages()}
        onStartReachedThreshold={0.5}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          setAtBottom(fromBottom < 80);
        }}
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
      {!atBottom && (
        <Pressable
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          accessibilityLabel="Jump to newest"
          className="absolute bottom-24 right-5 h-9 w-9 items-center justify-center rounded-full border border-border bg-secondary opacity-90 shadow-lg"
        >
          <Icon as={ArrowDown} tone="secondary-foreground" size={17} />
        </Pressable>
      )}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <TypingLine names={state.typingUsers.filter((u) => u !== state.userId).map(nameOf)} />
        <Composer
          key={`${roomId}|${channelId ?? ""}`}
          replyTo={replyTo}
          replyName={replyTo ? nameOf(replyTo.sender) : undefined}
          onClearReply={() => setReplyTo(null)}
          bottomInset={insets.bottom}
        />
      </KeyboardStickyView>
      <MessageActions message={acting} onClose={() => setActing(null)} onReply={setReplyTo} />
    </View>
  );
}

/** Who is typing, in the web's words, always holding its line's height. */
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
  return (
    <View className="h-5 flex-row items-center gap-1.5 px-4">
      {text ? (
        <>
          <View className="flex-row gap-0.5">
            {[0, 1, 2].map((i) => (
              <View key={i} className="h-1 w-1 rounded-full bg-muted-foreground" />
            ))}
          </View>
          <T className="flex-1 text-xs italic text-muted-foreground" numberOfLines={1}>
            {text}
          </T>
        </>
      ) : null}
    </View>
  );
}
