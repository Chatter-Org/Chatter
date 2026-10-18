import { useEffect, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, Link2, Pencil, Reply, SmilePlus, Trash2, type LucideProps } from "lucide-react-native";
import type { ComponentType } from "react";
import type { MatrixMessage } from "@chatter/core/api";
import { messageLinkFor } from "@chatter/core/messageLinks";
import { canManageMessages } from "@chatter/core/permissions";
import { isDeletedMessage } from "@chatter/core/messageFormat";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { Sheet } from "@/ui/Sheet";
import { EmojiPickerSheet } from "./EmojiPickerSheet";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

/**
 * What a held message offers: a quick reaction, reply, copy, a link to it,
 * and — for your own, or with the right to manage messages — edit and delete.
 * The web shows these on hover; a phone has a sheet.
 */
export function MessageActions({
  message,
  onClose,
  onReply,
}: {
  message: MatrixMessage | null;
  onClose(): void;
  onReply(message: MatrixMessage): void;
}) {
  const state = useChatter();
  const actions = useChatterActions();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const [draft, setDraft] = useState("");

  // A fresh sheet for each message held.
  useEffect(() => {
    if (message) setEditing(false);
  }, [message]);

  const mine = !!message && message.sender === state.userId;
  const deleted = !!message && isDeletedMessage(message);
  const mayDelete = !!message && !deleted && (mine || canManageMessages(state));
  const body = message?.content.body ?? "";

  const run = (fn: () => void) => () => {
    void Haptics.selectionAsync().catch(() => {});
    fn();
    onClose();
  };

  return (
    <Sheet open={!!message} onClose={onClose}>
      <View style={{ paddingBottom: 12 }}>
        {!message ? null : editing ? (
          <View className="gap-3 px-4 pb-2">
            <T className="font-mono-bold">Edit message</T>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              className="max-h-48 rounded-lg border border-input bg-card px-3 py-2 font-mono text-[15px] text-foreground"
            />
            <View className="flex-row justify-end gap-2">
              <SheetButton label="Cancel" onPress={() => setEditing(false)} />
              <SheetButton
                label="Save"
                primary
                onPress={run(() => {
                  const next = draft.trim();
                  if (next && next !== body) {
                    actions.editMessage(message.event_id, next).catch((e) => showToast({ message: String(e?.message ?? e), tone: "error" }));
                  }
                })}
              />
            </View>
          </View>
        ) : (
          <>
            {!deleted && (
              <View className="flex-row justify-around px-3 pb-3">
                {QUICK_REACTIONS.slice(0, 5).map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={run(() => void actions.addReaction(message.event_id, emoji))}
                    accessibilityLabel={`React ${emoji}`}
                    className="h-12 w-12 items-center justify-center rounded-full bg-muted"
                  >
                    <T className="text-2xl">{emoji}</T>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => setPicking(true)}
                  accessibilityLabel="More reactions"
                  className="h-12 w-12 items-center justify-center rounded-full bg-muted"
                >
                  <Icon as={SmilePlus} tone="foreground" size={22} />
                </Pressable>
              </View>
            )}
            <View className="mx-3 overflow-hidden rounded-xl bg-card">
              <Row icon={Reply} label="Reply" onPress={run(() => onReply(message))} />
              {!deleted && <Row icon={Copy} label="Copy text" onPress={run(() => void Clipboard.setStringAsync(body))} />}
              <Row
                icon={Link2}
                label="Copy message link"
                onPress={run(() => {
                  void Clipboard.setStringAsync(messageLinkFor(message.event_id));
                  showToast({ message: "Link copied" });
                })}
              />
              {mine && !deleted && (
                <Row
                  icon={Pencil}
                  label="Edit"
                  onPress={() => {
                    setDraft(body);
                    setEditing(true);
                  }}
                />
              )}
              {mayDelete && (
                <Row
                  icon={Trash2}
                  label="Delete"
                  destructive
                  onPress={() =>
                    Alert.alert("Delete message?", "This can't be undone.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: run(() =>
                          void actions.deleteMessage(message.event_id).catch((e) => showToast({ message: String(e?.message ?? e), tone: "error" })),
                        ),
                      },
                    ])
                  }
                />
              )}
            </View>
          </>
        )}
      </View>
      <EmojiPickerSheet
        open={picking}
        onClose={() => setPicking(false)}
        roomCustomEmojis={room?.custom_emojis}
        emojiAliases={room?.emoji_aliases}
        onPick={(emoji) => {
          if (message) void actions.addReaction(message.event_id, emoji);
          onClose();
        }}
      />
    </Sheet>
  );
}

function Row({ icon, label, onPress, destructive }: { icon: ComponentType<LucideProps>; label: string; onPress(): void; destructive?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="flex-row items-center gap-3 border-b border-border px-4 py-3.5 active:bg-accent">
      <Icon as={icon} tone={destructive ? "destructive" : "foreground"} size={18} />
      <T className={cn("text-[15px]", destructive && "text-destructive")}>{label}</T>
    </Pressable>
  );
}

function SheetButton({ label, onPress, primary }: { label: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className={cn("rounded-lg px-4 py-2.5", primary ? "bg-primary" : "bg-muted")}>
      <T className={cn(primary && "text-primary-foreground")}>{label}</T>
    </Pressable>
  );
}
