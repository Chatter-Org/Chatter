import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { CornerUpRight, File as FileIcon, Plus, RotateCw, SendHorizontal, Smile, X } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { discardOutgoing, enqueueOutgoing, retryOutgoing, isSameTarget, type OutgoingTarget } from "@chatter/core/outgoingUploads";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useOutgoingUploads } from "@/state/outgoing";
import { nativeUploadSource, type PickedFile } from "@/platform/uploads";
import { showToast } from "@/platform/toast";
import { AttachSheet, MAX_ATTACHMENTS } from "./AttachSheet";
import { EmojiPickerSheet } from "./EmojiPickerSheet";
import { isCustomEmojiUrl } from "@chatter/core/emojiCatalog";
import { findMentionMatches } from "@chatter/core/mentions";
import {
  completeToken,
  findShortcodeMatches,
  resolveShortcodes,
  roomShortcodes,
  shortcodeInsert,
  tokenAtCaret,
} from "@chatter/core/composerTokens";
import { ComposerSuggestions, type Suggestion } from "./ComposerSuggestions";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { useTheme } from "@/theme/ThemeProvider";

const isVisual = (type?: string | null) => !!type && /^(image|video)\//.test(type);

/** The message box: text, attachments, reply, send. */
export function Composer({
  replyTo,
  replyName,
  onClearReply,
  bottomInset,
}: {
  replyTo: MatrixMessage | null;
  replyName?: string;
  onClearReply(): void;
  bottomInset: number;
}) {
  const state = useChatter();
  const actions = useChatterActions();
  const { colors } = useTheme();
  const draftKey = `${state.currentRoomId}|${state.currentChannelId ?? ""}`;
  const [text, setText] = useState(() => state.drafts[draftKey] ?? "");
  const [staged, setStaged] = useState<PickedFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [sending, setSending] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const placeholder = channel ? `Message #${channel.name}` : "Message";
  const canSend = !!text.trim() || staged.length > 0;

  // Where the caret is, for the "@" and ":" suggestions; and a caret position
  // to put it at after a suggestion is taken (the box otherwise leaves it at
  // the end of the new text).
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [placeCaret, setPlaceCaret] = useState<{ start: number; end: number } | undefined>();
  const shortcodes = useMemo(() => roomShortcodes(room?.emoji_aliases), [room?.emoji_aliases]);
  const token = selection.start === selection.end ? tokenAtCaret(text, selection.end) : null;
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    if (token.kind === "mention") return findMentionMatches(state, token.query).map((match) => ({ kind: "mention", match }));
    return findShortcodeMatches(shortcodes, token.query, 5).map((m) => ({ kind: "emoji", ...m }));
    // The token's fields, not the object, which is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.kind, token?.query, shortcodes, state.roomMembers, state.customRoles, state.currentRoomId, state.roomInfoMap]);

  const takeSuggestion = (item: Suggestion) => {
    if (!token) return;
    const insert = item.kind === "mention" ? `@${item.match.name}` : shortcodeInsert(item.value);
    const next = completeToken(text, token, insert);
    onChange(next.text);
    setPlaceCaret({ start: next.caret, end: next.caret });
    setSelection({ start: next.caret, end: next.caret });
  };

  const here: OutgoingTarget | null = state.currentRoomId
    ? { kind: "channel", roomId: state.currentRoomId, channelId: state.currentChannelId ?? "" }
    : null;
  const outgoing = useOutgoingUploads();

  const onChange = (value: string) => {
    setText(value);
    if (value) actions.sendTyping();
    // Drafts follow the person to their other devices, a beat after they stop.
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const roomId = state.currentRoomId;
    const channelId = state.currentChannelId ?? "";
    if (roomId) draftTimer.current = setTimeout(() => void actions.saveDraft(roomId, channelId, value), 800);
  };

  const clearDraft = () => {
    setText("");
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (state.currentRoomId) void actions.saveDraft(state.currentRoomId, state.currentChannelId ?? "", "");
  };

  const send = async () => {
    // A ":name:" typed out in full becomes its emoji, as on the web.
    const body = resolveShortcodes(text.trim(), shortcodes);
    if (!canSend || sending || !state.currentRoomId) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

    // With files, the send is handed to the shared queue whole — destination
    // included — so it lands where it was written even if the reader moves on.
    if (staged.length > 0) {
      enqueueOutgoing({
        target: {
          kind: "channel",
          roomId: state.currentRoomId,
          channelId: state.currentChannelId ?? "",
          replyTo: replyTo?.event_id,
        },
        label: channel ? `#${channel.name}` : room?.name ?? "this conversation",
        body,
        files: staged.map(nativeUploadSource),
      });
      setStaged([]);
      clearDraft();
      onClearReply();
      return;
    }

    setSending(true);
    try {
      await actions.sendMessage(body, replyTo?.event_id);
      clearDraft();
      onClearReply();
    } catch (e) {
      // The text stays, so nothing typed is lost.
      showToast({ message: e instanceof Error ? e.message : "Message not sent", tone: "error" });
    } finally {
      setSending(false);
    }
  };

  return (
    <View className="bg-background px-3 pt-1" style={{ paddingBottom: Math.max(8, bottomInset) }}>
      {outgoing.map((batch) => {
        const elsewhere = !here || !isSameTarget(batch.target, here);
        return (
          <View key={batch.id} className="mb-1.5 gap-1">
            {elsewhere ? (
              <View className="flex-row items-center gap-1">
                <Icon as={CornerUpRight} size={12} />
                <T className="text-[11px] text-muted-foreground">Sending to {batch.label}</T>
              </View>
            ) : null}
            <View className="flex-row flex-wrap items-center gap-2">
              {batch.files.map((entry) => (
                <Tile
                  key={entry.id}
                  name={entry.file.name}
                  previewUri={entry.previewUrl}
                  status={entry.status}
                  pct={entry.pct}
                />
              ))}
              {batch.status === "failed" ? (
                <View className="flex-row gap-1.5">
                  <Pressable onPress={() => retryOutgoing(batch.id)} className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1" accessibilityLabel="Retry">
                    <Icon as={RotateCw} size={12} tone="foreground" />
                    <T className="text-xs">Retry</T>
                  </Pressable>
                  <Pressable onPress={() => discardOutgoing(batch.id)} className="rounded-md px-2 py-1" accessibilityLabel="Discard">
                    <T className="text-xs text-muted-foreground">Discard</T>
                  </Pressable>
                </View>
              ) : null}
            </View>
            {batch.error ? <T className="text-[11px] text-destructive">{batch.error}</T> : null}
          </View>
        );
      })}

      {replyTo ? (
        <View className="mb-1.5 flex-row items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <T className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            Replying to <T className="font-mono-bold text-xs text-foreground">{replyName}</T>
          </T>
          <Pressable onPress={onClearReply} hitSlop={10} accessibilityLabel="Cancel reply">
            <Icon as={X} size={14} />
          </Pressable>
        </View>
      ) : null}

      <ComposerSuggestions items={suggestions} onPick={takeSuggestion} />

      {staged.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 pb-2">
          {staged.map((file, i) => (
            <Tile
              key={`${file.uri}-${i}`}
              name={file.name}
              previewUri={isVisual(file.type) ? file.uri : null}
              onRemove={() => setStaged((s) => s.filter((_, j) => j !== i))}
            />
          ))}
        </ScrollView>
      ) : null}

      <View className="flex-row items-end gap-2">
        <Pressable
          onPress={() => setAttaching(true)}
          disabled={staged.length >= MAX_ATTACHMENTS}
          accessibilityRole="button"
          accessibilityLabel="Attach"
          className="h-11 w-11 items-center justify-center rounded-full bg-muted"
        >
          <Icon as={Plus} size={20} tone="foreground" />
        </Pressable>
        <View className="flex-1 flex-row items-end rounded-2xl border border-input bg-card pl-3.5">
          <TextInput
            value={text}
            onChangeText={onChange}
            selection={placeCaret}
            onSelectionChange={(e) => {
              setSelection(e.nativeEvent.selection);
              if (placeCaret) setPlaceCaret(undefined);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors["muted-foreground"]}
            multiline
            className="max-h-36 flex-1 py-2.5 font-mono text-[15px] text-foreground"
            accessibilityLabel={placeholder}
          />
          <Pressable onPress={() => setPickingEmoji(true)} accessibilityLabel="Emoji" className="h-11 w-10 items-center justify-center">
            <Icon as={Smile} size={20} />
          </Pressable>
        </View>
        <Pressable
          onPress={send}
          disabled={!canSend || sending}
          accessibilityRole="button"
          accessibilityLabel="Send"
          className={cn("h-11 w-11 items-center justify-center rounded-full", canSend ? "bg-primary" : "bg-muted")}
        >
          {sending ? (
            <ActivityIndicator color={colors["primary-foreground"]} />
          ) : (
            <Icon as={SendHorizontal} size={18} tone={canSend ? "primary-foreground" : "muted-foreground"} />
          )}
        </Pressable>
      </View>

      <EmojiPickerSheet
        open={pickingEmoji}
        onClose={() => setPickingEmoji(false)}
        roomCustomEmojis={room?.custom_emojis}
        emojiAliases={room?.emoji_aliases}
        // A room's emoji goes in as the marker the message format reads.
        onPick={(emoji) => onChange(text + (isCustomEmojiUrl(emoji) ? `:emoji{${emoji}}:` : emoji))}
      />
      <AttachSheet
        open={attaching}
        onClose={() => setAttaching(false)}
        room={MAX_ATTACHMENTS - staged.length}
        onPicked={(files) => setStaged((s) => [...s, ...files].slice(0, MAX_ATTACHMENTS))}
      />
    </View>
  );
}

/** A staged or sending file: its picture, or its name, with progress. */
function Tile({
  name,
  previewUri,
  status,
  pct = 0,
  onRemove,
}: {
  name: string;
  previewUri: string | null;
  status?: "queued" | "uploading" | "processing" | "done" | "failed";
  pct?: number;
  onRemove?(): void;
}) {
  const busy = status === "queued" || status === "uploading" || status === "processing";
  return (
    <View className="h-16 w-16 overflow-hidden rounded-lg border border-border bg-muted">
      {previewUri ? (
        <Image source={{ uri: previewUri }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
      ) : (
        <View className="flex-1 items-center justify-center gap-0.5 px-1">
          <Icon as={FileIcon} size={18} />
          <T className="text-[9px] text-muted-foreground" numberOfLines={1}>
            {name}
          </T>
        </View>
      )}
      {busy ? (
        <View className="absolute inset-0 items-center justify-center bg-black/40">
          {status === "uploading" ? <T className="font-mono-bold text-xs text-white">{pct}%</T> : <ActivityIndicator color="#fff" size="small" />}
        </View>
      ) : null}
      {status === "failed" ? <View className="absolute inset-0 border-2 border-destructive rounded-lg" /> : null}
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${name}`} className="absolute right-0.5 top-0.5 h-5 w-5 items-center justify-center rounded-full bg-black/60">
          <X size={12} color="#fff" />
        </Pressable>
      ) : null}
    </View>
  );
}
