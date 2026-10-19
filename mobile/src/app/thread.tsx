import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { router } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { ArrowLeft, Reply } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { groupsWith } from "@chatter/core/messageFormat";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { MessageRow } from "@/components/MessageRow";
import { MessageBody } from "@/components/MessageBody";
import { MessageMedia } from "@/components/MessageMedia";
import { MessageActions } from "@/components/MessageActions";
import { Composer } from "@/components/Composer";
import { useMessageRows } from "@/components/useMessageRows";
import { extractMedia } from "@chatter/core/messageFormat";
import { Icon, T } from "@/ui/primitives";
import { UI_HEADING, UI_META } from "@/ui/roles";

/**
 * A thread — the web's ThreadPanel as a screen of its own: back to the chat,
 * its name and where it hangs, who is in it, the message it started from, then
 * the replies and a composer that answers in the thread. Back (the button,
 * the gesture or the system's) closes it.
 */
export default function ThreadScreen() {
  const insets = useSafeAreaInsets();
  return <ThreadView onClose={() => router.back()} top={insets.top} />;
}

/**
 * The thread itself, for the screen above and for the pane beside the
 * conversation on a wide window (PanelLayout). `onClose` is how it is left;
 * `top` is the status bar it must clear, if it reaches the top of the window.
 */
export function ThreadView({ onClose, top }: { onClose(): void; top: number }) {
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const { rowData, nameOf, formatOptions } = useMessageRows();
  const [replyTo, setReplyTo] = useState<MatrixMessage | null>(null);
  const [acting, setActing] = useState<MatrixMessage | null>(null);
  const root = state.threadRootMessage;
  const threadId = state.activeThreadEventId;
  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);

  // Leaving, by any way out, closes the thread in the store.
  useEffect(() => () => actions.closeThread(), [actions]);

  const keyboard = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, keyboard.height.value + insets.bottom) }] }));

  const renderItem = useCallback(
    ({ item, index }: { item: MatrixMessage; index: number }) => (
      <MessageRow
        {...rowData(item)}
        message={item}
        grouped={groupsWith(state.threadMessages[index - 1], item)}
        onReply={setReplyTo}
        onLongPress={setActing}
      />
    ),
    [rowData, state.threadMessages],
  );

  const participants = root?.thread_participants ?? state.threadPosters;
  const title = root?.thread_name || "Thread";

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      {/* ThreadPanel's header, as the phone's header. */}
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back to chat"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={ArrowLeft} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold" numberOfLines={1}>
            {title}
          </T>
          {channel ? (
            <T className={UI_META} numberOfLines={1}>
              #{channel.name}
            </T>
          ) : null}
        </View>
      </View>

      {participants.length > 0 ? (
        <View className="flex-row items-center gap-1.5 border-b border-border/50 px-3 py-1.5">
          <T className={UI_HEADING}>Members</T>
          <View className="flex-row">
            {participants.slice(0, 8).map((id, i) => (
              <View key={id} style={{ marginLeft: i ? -6 : 0 }} className="rounded-full border-2 border-background">
                <Avatar userId={id} name={nameOf(id)} url={state.userPresence[id]?.avatarUrl} size={22} textClassName="text-3xs" />
              </View>
            ))}
          </View>
          <T className={UI_META}>{participants.length}</T>
        </View>
      ) : null}

      {!root || !threadId ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <FlashList
          data={state.threadMessages}
          keyExtractor={(m) => m.event_id}
          renderItem={renderItem}
          maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
          onStartReached={() => void actions.loadOlderThreadMessages()}
          onStartReachedThreshold={0.5}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View>
              {/* The message the thread hangs from. */}
              <View className="border-b border-border/50 px-3 pb-2 pt-3">
                <View className="flex-row items-start gap-2">
                  <View className="mt-0.5">
                    <Avatar userId={root.sender} name={nameOf(root.sender)} url={state.userPresence[root.sender]?.avatarUrl} size={31} />
                  </View>
                  <View className="min-w-0 flex-1">
                    <View className="flex-row items-baseline gap-1.5">
                      <T className="shrink text-sm font-semibold" numberOfLines={1}>
                        {nameOf(root.sender)}
                      </T>
                      <T className="text-xs text-muted-foreground">
                        {new Date(root.origin_server_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </T>
                    </View>
                    <View className="mt-0.5">
                      <MessageBody body={root.content.body ?? ""} options={formatOptions} edited={root.edited} />
                      <MessageMedia media={extractMedia(root.content.body ?? "")} />
                    </View>
                  </View>
                  {/* The root is part of the conversation, so it can be answered. */}
                  <Pressable onPress={() => setReplyTo(root)} hitSlop={8} accessibilityLabel="Reply to this message" className="p-1">
                    <Icon as={Reply} size={16} />
                  </Pressable>
                </View>
              </View>
              <View className="flex-row items-center gap-2 px-3 py-1.5">
                <T className="text-xs font-medium text-muted-foreground">
                  {state.threadMessages.length} {state.threadMessages.length === 1 ? "reply" : "replies"}
                  {state.threadHasMore ? "+" : ""}
                </T>
                <View className="h-px flex-1 bg-border" />
              </View>
              {state.threadLoadingOlder ? (
                <T className="py-2 text-center text-xs text-muted-foreground">Loading older replies...</T>
              ) : null}
            </View>
          }
          ListFooterComponent={<View style={{ height: 8 }} />}
        />
      )}

      <Animated.View style={lift}>
        {threadId ? (
          <Composer
            key={threadId}
            threadEventId={threadId}
            replyTo={replyTo}
            replyName={replyTo ? nameOf(replyTo.sender) : undefined}
            onClearReply={() => setReplyTo(null)}
            bottomInset={insets.bottom}
          />
        ) : null}
      </Animated.View>
      <MessageActions message={acting} onClose={() => setActing(null)} onReply={setReplyTo} />
    </View>
  );
}
