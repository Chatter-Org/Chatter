import { useEffect, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, Link2, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { messageLinkFor } from "@chatter/core/messageLinks";
import { canManageMessages } from "@chatter/core/permissions";
import { isDeletedMessage } from "@chatter/core/messageFormat";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Icon, T } from "@/ui/primitives";
import { Button } from "@/ui/controls";
import { Sheet, SheetRow } from "@/ui/Sheet";
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
    // MessageItem's touch sheet: "Message", then its actions as rows.
    <Sheet open={!!message} onClose={onClose} title={editing ? "Edit message" : "Message"}>
      <View>
        {!message ? null : editing ? (
          <View className="gap-2 px-4 pt-2">
            {/* The web's edit box. */}
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              className="max-h-40 rounded-md border border-input px-3 py-2 font-mono text-sm leading-5 text-foreground"
            />
            <T className="text-xs text-muted-foreground">Saved for everyone, marked as edited.</T>
            <View className="flex-row justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onPress={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onPress={run(() => {
                  const next = draft.trim();
                  if (next && next !== body) {
                    actions.editMessage(message.event_id, next).catch((e) => showToast({ message: String(e?.message ?? e), tone: "error" }));
                  }
                })}
              >
                Save
              </Button>
            </View>
          </View>
        ) : (
          <>
            {!deleted && (
              // A phone's shortcut the web doesn't need: the common reactions,
              // one tap away, in the web's reaction-pill style.
              <View className="flex-row justify-around px-3 pb-2 pt-2">
                {QUICK_REACTIONS.slice(0, 5).map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={run(() => void actions.addReaction(message.event_id, emoji))}
                    accessibilityLabel={`React ${emoji}`}
                    className="size-11 items-center justify-center rounded-full border border-border active:bg-accent"
                  >
                    <T className="text-xl">{emoji}</T>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => setPicking(true)}
                  accessibilityLabel="More reactions"
                  className="size-11 items-center justify-center rounded-full border border-border active:bg-accent"
                >
                  <Icon as={SmilePlus} size={20} />
                </Pressable>
              </View>
            )}
            <View>
              <SheetRow icon={Reply} label="Reply" onPress={run(() => onReply(message))} />
              {!deleted && <SheetRow icon={Copy} label="Copy text" onPress={run(() => void Clipboard.setStringAsync(body))} />}
              <SheetRow
                icon={Link2}
                label="Copy message link"
                onPress={run(() => {
                  void Clipboard.setStringAsync(messageLinkFor(message.event_id));
                  showToast({ message: "Link copied" });
                })}
              />
              {mine && !deleted && (
                <SheetRow
                  icon={Pencil}
                  label="Edit"
                  onPress={() => {
                    setDraft(body);
                    setEditing(true);
                  }}
                />
              )}
              {mayDelete && (
                <SheetRow
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
        title="Add reaction"
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
