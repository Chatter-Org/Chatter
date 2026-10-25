import { memo, useMemo, useState } from "react";
import { Pressable, View, type TextInputProps } from "react-native";
import { AtSign } from "lucide-react-native";
import { findMentionMatches, type MentionMatch } from "@chatter/core/mentions";
import { completeToken, findShortcodeMatches, roomShortcodes, shortcodeInsert, tokenAtCaret } from "@chatter/core/composerTokens";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { EmojiGlyph } from "./EmojiPickerSheet";
import { Icon, T } from "@/ui/primitives";

export type Suggestion =
  | { kind: "mention"; match: MentionMatch }
  | { kind: "emoji"; name: string; value: string };

/**
 * The "@" and ":" suggestions for a text box: where its caret is, what the
 * word at the caret could finish as, and taking one. A box spreads `input`
 * onto its TextInput and shows `items` in ComposerSuggestions. The forum's
 * boxes, as on the web, offer mentions only (`emoji: false`).
 */
export function useComposerSuggestions(text: string, onChange: (value: string) => void, { emoji = true }: { emoji?: boolean } = {}) {
  const state = useChatter();
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  // And a caret position to put it at after a suggestion is taken (the box
  // otherwise leaves it at the end of the new text).
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [placeCaret, setPlaceCaret] = useState<{ start: number; end: number } | undefined>();
  const shortcodes = useMemo(() => roomShortcodes(room?.emoji_aliases), [room?.emoji_aliases]);
  const found = selection.start === selection.end ? tokenAtCaret(text, selection.end) : null;
  const token = found && (emoji || found.kind === "mention") ? found : null;
  const items = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    if (token.kind === "mention") return findMentionMatches(state, token.query).map((match) => ({ kind: "mention", match }));
    return findShortcodeMatches(shortcodes, token.query, 5).map((m) => ({ kind: "emoji", ...m }));
    // The token's fields, not the object, which is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.kind, token?.query, shortcodes, state.roomMembers, state.customRoles, state.currentRoomId, state.roomInfoMap]);

  const pick = (item: Suggestion) => {
    if (!token) return;
    const insert = item.kind === "mention" ? `@${item.match.name}` : shortcodeInsert(item.value);
    const next = completeToken(text, token, insert);
    onChange(next.text);
    setPlaceCaret({ start: next.caret, end: next.caret });
    setSelection({ start: next.caret, end: next.caret });
  };

  const input: Pick<TextInputProps, "selection" | "onSelectionChange"> = {
    selection: placeCaret,
    onSelectionChange: (e) => {
      setSelection(e.nativeEvent.selection);
      if (placeCaret) setPlaceCaret(undefined);
    },
  };

  return { items, pick, input, shortcodes };
}

/**
 * What the composer offers to finish: members and roles after an "@", emoji
 * after a ":". A short list right above the box — a tap puts it in, typing on
 * past it ignores it, as with a keyboard's own suggestions.
 */
export const ComposerSuggestions = memo(function ComposerSuggestions({
  items,
  onPick,
}: {
  items: Suggestion[];
  onPick(item: Suggestion): void;
}) {
  if (items.length === 0) return null;
  return (
    <View
      className="mb-1.5 overflow-hidden rounded-xl border border-border bg-popover py-1"
      accessibilityRole="menu"
      accessibilityLabel="Suggestions"
    >
      {items.slice(0, 5).map((item) => (
        <Pressable
          key={item.kind === "mention" ? `${item.match.kind}:${item.match.id}` : `emoji:${item.name}`}
          onPress={() => onPick(item)}
          accessibilityRole="menuitem"
          className="min-h-11 flex-row items-center gap-3 px-3 py-1.5 active:bg-accent"
        >
          {item.kind === "mention" ? <MentionRow match={item.match} /> : <EmojiRow name={item.name} value={item.value} />}
        </Pressable>
      ))}
    </View>
  );
});

function MentionRow({ match }: { match: MentionMatch }) {
  const state = useChatter();
  if (match.kind === "user") {
    const presence = state.userPresence[match.id];
    return (
      <>
        <Avatar userId={match.id} name={match.name} url={presence?.avatarUrl} size={28} />
        <T className="flex-1 text-[15px]" numberOfLines={1}>
          {match.name}
        </T>
      </>
    );
  }
  return (
    <>
      <View className="h-7 w-7 items-center justify-center rounded-full bg-muted">
        <Icon as={AtSign} size={15} color={match.color} />
      </View>
      <T className="flex-1 text-[15px]" style={match.color ? { color: match.color } : undefined} numberOfLines={1}>
        {match.name}
      </T>
      <T className="text-[11px] text-muted-foreground">role</T>
    </>
  );
}

function EmojiRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <View className="h-7 w-7 items-center justify-center">
        <EmojiGlyph emoji={value} size={24} />
      </View>
      <T className="flex-1 text-[15px]" numberOfLines={1}>
        :{name}:
      </T>
    </>
  );
}
