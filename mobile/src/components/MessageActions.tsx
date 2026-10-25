import { useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy, Flag, Link2, MessagesSquare, Pencil, Pin, PinOff, Reply, SmilePlus, Trash2 } from "lucide-react-native";
import { apiReportMessage, type MatrixMessage } from "@chatter/core/api";
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
/** As on the web's report dialog. */
const REPORT_REASONS = ["Spam", "Harassment", "Hate speech", "Explicit content", "Scam or phishing"];

/**
 * What a held message offers: a quick reaction, reply, copy, a link to it,
 * and — for your own, or with the right to manage messages — edit and delete.
 * The web shows these on hover; a phone has a sheet.
 */
export function MessageActions({
  message,
  onClose,
  onReply,
  onOpenThread,
}: {
  message: MatrixMessage | null;
  onClose(): void;
  onReply(message: MatrixMessage): void;
  /** Absent inside a thread: there is no thread in a thread. */
  onOpenThread?(eventId: string): void;
}) {
  const state = useChatter();
  const actions = useChatterActions();
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [picking, setPicking] = useState(false);
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const [draft, setDraft] = useState("");

  // A fresh sheet for each message held.
  const [heldMessage, setHeldMessage] = useState(message);
  if (heldMessage !== message) {
    setHeldMessage(message);
    if (message) {
      setEditing(false);
      setReporting(false);
    }
  }

  const mine = !!message && message.sender === state.userId;
  const deleted = !!message && isDeletedMessage(message);
  const mayDelete = !!message && !deleted && (mine || canManageMessages(state));
  const body = message?.content.body ?? "";
  // As on the web: moderators pin, in the channel (a thread's pins are its own).
  const canPin = !!message && !deleted && !!onOpenThread && message.content.msgtype !== "m.system" && canManageMessages(state);
  const isPinned = !!message && state.pinnedMessages.some((m) => m.event_id === message.event_id);
  // Reports go to the room's moderators, so a DM has nowhere to send one.
  const canReport =
    !!message && !mine && !deleted && message.content.msgtype !== "m.system" && !!room && !room.is_direct && room.moderation?.reports_enabled !== false;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    // MessageItem's touch sheet: "Message", then its actions as rows.
    <Sheet open={!!message} onClose={onClose} title={editing ? "Edit message" : reporting ? "Report message" : "Message"}>
      <View>
        {!message ? null : reporting ? (
          <View className="gap-2 px-4 pt-2">
            <T className="text-xs text-muted-foreground">
              Goes to this room&apos;s moderators, who see who reported it.
            </T>
            <View className="flex-row flex-wrap gap-1.5">
              {REPORT_REASONS.map((r) => (
                <Button key={r} size="sm" variant={reason === r ? "default" : "outline"} onPress={() => setReason(r)}>
                  {r}
                </Button>
              ))}
            </View>
            <TextInput
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={500}
              placeholder="What's wrong with it? (optional)"
              className="max-h-32 rounded-md border border-input px-3 py-2 font-mono text-sm leading-5 text-foreground"
            />
            <View className="flex-row justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onPress={() => setReporting(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onPress={run(() => {
                  if (!state.currentRoomId) return;
                  apiReportMessage(state.currentRoomId, message.event_id, reason.trim())
                    .then(() => showToast({ message: "Reported. The room's moderators will take a look." }))
                    .catch((e) => showToast({ message: String(e?.message ?? e), tone: "error" }));
                })}
              >
                Report
              </Button>
            </View>
          </View>
        ) : editing ? (
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
              {onOpenThread && !deleted && message.content.msgtype !== "m.system" ? (
                <SheetRow icon={MessagesSquare} label="Open thread" onPress={run(() => onOpenThread(message.event_id))} />
              ) : null}
              {!deleted && <SheetRow icon={Copy} label="Copy text" onPress={run(() => void Clipboard.setStringAsync(body))} />}
              {canPin ? (
                <SheetRow
                  icon={isPinned ? PinOff : Pin}
                  label={isPinned ? "Unpin message" : "Pin message"}
                  onPress={run(() =>
                    void (isPinned ? actions.unpinMessage(message.event_id) : actions.pinMessage(message.event_id)).catch((e) =>
                      showToast({ message: String(e?.message ?? e), tone: "error" }),
                    ),
                  )}
                />
              ) : null}
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
              {canReport && (
                <SheetRow
                  icon={Flag}
                  label="Report message"
                  onPress={() => {
                    setReason("");
                    setReporting(true);
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
