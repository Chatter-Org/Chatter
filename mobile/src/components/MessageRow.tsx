import { memo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, useCompetingGestures, useLongPressGesture, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { EyeOff, MessagesSquare, MoreHorizontal, Reply } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import type { FormatOptions } from "@chatter/core/messageFormat";
import { extractMedia, isDeletedMessage } from "@chatter/core/messageFormat";
import { Tap } from "./Tap";
import { PollCard, PollResultsCard } from "./PollCard";
import { EmbedCard } from "./EmbedCard";
import { useShowProfile } from "./ProfileSheet";
import { Avatar } from "./Avatar";
import { BODY_TEXT, MessageBody } from "./MessageBody";
import { MessageMedia } from "./MessageMedia";
import { EmojiGlyph } from "./EmojiPickerSheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";

/** The web's avatar size below 768px (h-7). */
const AVATAR = 31;

/** How far a row must be dragged to count as "reply". */
const REPLY_THRESHOLD = 64;

export interface MessageRowProps {
  message: MatrixMessage;
  grouped: boolean;
  senderName: string;
  senderColor?: string;
  avatarUrl?: string;
  /** BOT or HOOK: the sender is not a member, and has no profile to open. */
  senderBadge?: "BOT" | "HOOK";
  status?: string;
  replySenderName?: string;
  reactions?: Record<string, string[]>;
  myUserId: string | null;
  mentionsMe: boolean;
  /** Just jumped to: lit for a moment. */
  highlighted?: boolean;
  formatOptions: FormatOptions;
  onReply(message: MatrixMessage): void;
  onLongPress(message: MatrixMessage): void;
  onReact(eventId: string, emoji: string): void;
  /** Open the thread hanging off this message; absent inside a thread. */
  onOpenThread?(eventId: string): void;
}

/**
 * One message: a header (avatar, name, time) unless it continues the sender's
 * group, a reply preview, the body, its pictures and its reactions.
 *
 * Swipe it left to reply; hold it for its actions.
 */
export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message, grouped, onReply, onLongPress } = props;
  const dx = useSharedValue(0);
  const armed = useSharedValue(false);

  const buzz = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  const pan = usePanGesture({
    // Leftward only: rightward belongs to the panels.
    activeOffsetX: [-14, 100000],
    failOffsetY: [-10, 10],
    onUpdate: (e) => {
      "worklet";
      dx.value = Math.max(-REPLY_THRESHOLD * 1.4, Math.min(0, e.translationX));
      const past = -dx.value >= REPLY_THRESHOLD;
      if (past !== armed.value) {
        armed.value = past;
        if (past) scheduleOnRN(buzz);
      }
    },
    onDeactivate: () => {
      "worklet";
      if (armed.value) scheduleOnRN(onReply, message);
      armed.value = false;
      dx.value = withSpring(0, { damping: 20, stiffness: 300 });
    },
  });

  // Holding a message is a gesture of its own rather than Pressable's
  // onLongPress: inside a gesture-handler detector the JS responder is
  // cancelled as soon as the native pan begins tracking, so a long press
  // never arrived. The two compete; moving first makes it a swipe.
  const pressed = useSharedValue(false);
  const hold = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onLongPress(message);
  };
  const longPress = useLongPressGesture({
    minDuration: 320,
    maxDistance: 12,
    onBegin: () => {
      "worklet";
      pressed.value = true;
    },
    onActivate: () => {
      "worklet";
      scheduleOnRN(hold);
    },
    onFinalize: () => {
      "worklet";
      pressed.value = false;
    },
  });
  const gesture = useCompetingGestures(pan, longPress);

  const pressStyle = useAnimatedStyle(() => ({ opacity: pressed.value ? 0.75 : 1 }));
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
  const hintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(-dx.value, [12, REPLY_THRESHOLD], [0, 1], "clamp"),
    transform: [{ scale: interpolate(-dx.value, [12, REPLY_THRESHOLD], [0.6, 1], "clamp") }],
  }));

  return (
    <View>
      <Animated.View style={[{ position: "absolute", right: 16, top: 0, bottom: 0, justifyContent: "center" }, hintStyle]}>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
          <Icon as={Reply} size={16} tone="foreground" />
        </View>
      </Animated.View>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[rowStyle, pressStyle]}>
          {/* MessageItem's row at phone width: msg-row-mobile / -grouped,
              and a message that names you tinted (no border, as on the web). */}
          <View className={cn("mx-1 rounded-md px-2", grouped ? "-mt-0.5 py-1" : "pb-1 pt-2", props.mentionsMe && "bg-mention/10", props.highlighted && "bg-accent")}>
            <RowContent {...props} />
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

function RowContent({
  message,
  grouped,
  senderName,
  senderColor,
  avatarUrl,
  senderBadge,
  status,
  replySenderName,
  reactions,
  myUserId,
  formatOptions,
  onReact,
  onLongPress,
  onOpenThread,
}: MessageRowProps) {
  const showProfile = useShowProfile();
  const deleted = isDeletedMessage(message);
  const body = message.content.body ?? "";
  const media = extractMedia(body);
  const time = new Date(message.origin_server_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const isSystem = message.content.msgtype === "m.system";

  if (isSystem) {
    // A line across with the event in a pill, as on the web.
    const left = /\bleft\b/i.test(body);
    return (
      <View className="flex-row items-center gap-2 py-0.5">
        <View className="h-px flex-1 bg-border" />
        <View className={cn("rounded-full px-2 py-0.5", left ? "bg-destructive/10" : "bg-success/10")}>
          <T className={cn("text-xs font-medium", left ? "text-destructive/80" : "text-success/80")} numberOfLines={1}>
            {body}
          </T>
        </View>
        <T className="text-2xs text-muted-foreground/80">{time}</T>
        <View className="h-px flex-1 bg-border" />
      </View>
    );
  }

  return (
    <View className="flex-row items-start gap-1.5">
      {/* h-7: the web's avatar below 768px; grouped rows keep its width. */}
      <View className="mt-0.5" style={{ width: AVATAR }}>
        {!grouped && (
          senderBadge ? (
            <Avatar name={senderName} url={avatarUrl} size={AVATAR} textClassName="text-3xs" />
          ) : (
            <Tap onPress={() => showProfile(message.sender)} label={`${senderName}'s profile`} className="rounded-full">
              <Avatar userId={message.sender} name={senderName} url={avatarUrl} size={AVATAR} textClassName="text-3xs" />
            </Tap>
          )
        )}
      </View>
      <View className="min-w-0 flex-1">
        {message.content.in_reply_to && replySenderName ? (
          <View className="mb-1 flex-row items-center gap-1.5 border-l-2 border-primary/50 pl-2">
            <T className="text-xs font-semibold text-muted-foreground">{replySenderName}</T>
            <T className={cn("flex-1 text-xs text-muted-foreground", message.content.reply_to_spoiler && "italic")} numberOfLines={1}>
              {message.content.reply_to_spoiler ? "Spoiler message" : message.content.reply_to_body || "…"}
            </T>
          </View>
        ) : null}
        {!grouped && (
          <View className="flex-row items-baseline gap-2">
            {senderBadge ? (
              <>
                <T className="shrink text-sm font-semibold" numberOfLines={1}>
                  {senderName}
                </T>
                {/* MessageItem's BOT / HOOK tag. */}
                <View className="rounded bg-indigo-500/20 px-1 py-0.5">
                  <T className="text-3xs font-semibold text-indigo-400">{senderBadge}</T>
                </View>
              </>
            ) : (
              <Tap onPress={() => showProfile(message.sender)} label={`${senderName}'s profile`} className="shrink rounded">
                <T className="text-sm font-semibold" style={senderColor ? { color: senderColor } : undefined} numberOfLines={1}>
                  {senderName}
                </T>
              </Tap>
            )}
            <T className="text-xs text-muted-foreground">{time}</T>
          </View>
        )}
        {!grouped ? <View className="h-0.5" /> : null}
        {deleted ? (
          <T className={cn(BODY_TEXT, "italic text-muted-foreground opacity-60")}>message deleted</T>
        ) : message.content.msgtype === "m.poll" ? (
          <PollCard message={message} />
        ) : message.content.msgtype === "m.poll_results" ? (
          <PollResultsCard message={message} />
        ) : message.content.spoiler ? (
          <SpoilerBody body={body} options={formatOptions} edited={message.edited} />
        ) : (
          <>
            <MessageBody body={body} options={formatOptions} edited={message.edited} />
            <MessageMedia media={media} />
            {message.content.embeds?.map((embed, i) => <EmbedCard key={i} embed={embed} eventId={message.event_id} />)}
          </>
        )}
        {onOpenThread && (message.thread_reply_count ?? 0) > 0 ? (
          // The web's thread link under a message: how many replies, in the
          // primary colour.
          <Tap onPress={() => onOpenThread(message.event_id)} label="Open thread" className="mt-1 flex-row items-center gap-1.5 self-start rounded py-0.5">
            <Icon as={MessagesSquare} size={15} tone="primary" />
            <T className="text-xs text-primary">
              {message.thread_name ? `${message.thread_name} · ` : ""}
              {message.thread_reply_count} {message.thread_reply_count === 1 ? "reply" : "replies"}
            </T>
          </Tap>
        ) : null}
        {reactions && Object.keys(reactions).length > 0 ? (
          <View className="mt-1.5 flex-row flex-wrap gap-1">
            {Object.entries(reactions).map(([emoji, users]) => {
              const mine = !!myUserId && users.includes(myUserId);
              return (
                <Tap
                  key={emoji}
                  onPress={() => onReact(message.event_id, emoji)}
                  label={`${emoji} ${users.length}${mine ? ", you reacted" : ""}`}
                  className={cn(
                    "min-h-7 flex-row items-center gap-1 rounded-full border px-2 py-0.5",
                    mine ? "border-primary/50 bg-primary/10" : "border-border",
                  )}
                >
                  <EmojiGlyph emoji={emoji} size={17} />
                  <T className="text-sm font-medium text-muted-foreground">{users.length}</T>
                </Tap>
              );
            })}
          </View>
        ) : null}
      </View>
      {/* The web's touch "…": the same actions as holding the message. */}
      <Tap onPress={() => onLongPress(message)} label="Message actions" className="mt-0.5 rounded-md p-1 opacity-60">
        <Icon as={MoreHorizontal} size={17} />
      </Tap>
    </View>
  );
}

function SpoilerBody({ body, options, edited }: { body: string; options: FormatOptions; edited?: boolean }) {
  const [shown, setShown] = useReveal();
  if (shown) return <MessageBody body={body} options={options} edited={edited} />;
  return (
    <Pressable
      onPress={setShown}
      accessibilityRole="button"
      accessibilityLabel="Spoiler, tap to reveal"
      className="mt-0.5 flex-row items-center gap-1.5 self-start rounded-md bg-muted px-3 py-1.5 active:bg-muted/70"
    >
      <Icon as={EyeOff} size={15} />
      <T className="text-xs font-medium text-muted-foreground">Spoiler — tap to reveal</T>
    </Pressable>
  );
}

function useReveal(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  return [shown, () => setShown(true)];
}
