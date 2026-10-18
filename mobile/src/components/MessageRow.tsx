import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, useCompetingGestures, useLongPressGesture, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Reply } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import type { FormatOptions } from "@chatter/core/messageFormat";
import { extractMedia, isDeletedMessage } from "@chatter/core/messageFormat";
import { Avatar } from "./Avatar";
import { MessageBody } from "./MessageBody";
import { MessageMedia } from "./MessageMedia";
import { EmojiGlyph } from "./EmojiPickerSheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";

/** How far a row must be dragged to count as "reply". */
const REPLY_THRESHOLD = 64;

export interface MessageRowProps {
  message: MatrixMessage;
  grouped: boolean;
  senderName: string;
  senderColor?: string;
  avatarUrl?: string;
  status?: string;
  replySenderName?: string;
  reactions?: Record<string, string[]>;
  myUserId: string | null;
  mentionsMe: boolean;
  formatOptions: FormatOptions;
  onReply(message: MatrixMessage): void;
  onLongPress(message: MatrixMessage): void;
  onReact(eventId: string, emoji: string): void;
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
          <View
            className={cn(
              "px-3",
              grouped ? "pt-0.5" : "pt-3",
              props.mentionsMe && "bg-mention/10 border-l-2 border-mention",
            )}
          >
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
  status,
  replySenderName,
  reactions,
  myUserId,
  formatOptions,
  onReact,
}: MessageRowProps) {
  const deleted = isDeletedMessage(message);
  const body = message.content.body ?? "";
  const media = extractMedia(body);
  const time = new Date(message.origin_server_ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isSystem = message.content.msgtype === "m.system";

  if (isSystem) {
    return <T className="py-1 text-center text-xs text-muted-foreground">{body}</T>;
  }

  return (
    <View className="flex-row gap-3">
      <View style={{ width: 38 }}>
        {!grouped && <Avatar userId={message.sender} name={senderName} url={avatarUrl} size={38} />}
      </View>
      <View className="flex-1 pb-0.5">
        {message.content.in_reply_to && replySenderName ? (
          <View className="mb-1 flex-row items-center gap-1.5 border-l-2 border-border pl-2">
            <T className="font-mono-medium text-xs text-muted-foreground">{replySenderName}</T>
            <T className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              {message.content.reply_to_spoiler ? "spoiler" : message.content.reply_to_body || "…"}
            </T>
          </View>
        ) : null}
        {!grouped && (
          <View className="mb-0.5 flex-row items-baseline gap-2">
            <T className="font-mono-bold text-[15px]" style={senderColor ? { color: senderColor } : undefined} numberOfLines={1}>
              {senderName}
            </T>
            <T className="text-[11px] text-muted-foreground">{time}</T>
          </View>
        )}
        {deleted ? (
          <T className="text-sm italic text-muted-foreground">message deleted</T>
        ) : message.content.spoiler ? (
          <SpoilerBody body={body} options={formatOptions} edited={message.edited} />
        ) : (
          <>
            <MessageBody body={body} options={formatOptions} edited={message.edited} />
            <MessageMedia media={media} />
          </>
        )}
        {reactions && Object.keys(reactions).length > 0 ? (
          <View className="mt-1.5 flex-row flex-wrap gap-1.5">
            {Object.entries(reactions).map(([emoji, users]) => {
              const mine = !!myUserId && users.includes(myUserId);
              return (
                <Pressable
                  key={emoji}
                  onPress={() => onReact(message.event_id, emoji)}
                  accessibilityRole="button"
                  accessibilityLabel={`${emoji} ${users.length}${mine ? ", you reacted" : ""}`}
                  className={cn("flex-row items-center gap-1 rounded-full border px-2 py-0.5", mine ? "border-primary bg-primary/15" : "border-border bg-muted")}
                >
                  <EmojiGlyph emoji={emoji} size={18} />
                  <T className="text-xs text-muted-foreground">{users.length}</T>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function SpoilerBody({ body, options, edited }: { body: string; options: FormatOptions; edited?: boolean }) {
  const [shown, setShown] = useReveal();
  if (shown) return <MessageBody body={body} options={options} edited={edited} />;
  return (
    <Pressable onPress={setShown} accessibilityRole="button" accessibilityLabel="Spoiler, tap to reveal" className="self-start rounded-md bg-muted px-3 py-1.5">
      <T className="text-xs text-muted-foreground">spoiler — tap to reveal</T>
    </Pressable>
  );
}

function useReveal(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  return [shown, () => setShown(true)];
}
