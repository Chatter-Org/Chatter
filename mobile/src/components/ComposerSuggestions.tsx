import { memo } from "react";
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { AtSign } from "lucide-react-native";
import type { MentionMatch } from "@chatter/core/mentions";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { EmojiGlyph } from "./EmojiPickerSheet";
import { Icon, T } from "@/ui/primitives";

export type Suggestion =
  | { kind: "mention"; match: MentionMatch }
  | { kind: "emoji"; name: string; value: string };

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
          onPress={() => {
            void Haptics.selectionAsync();
            onPick(item);
          }}
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
