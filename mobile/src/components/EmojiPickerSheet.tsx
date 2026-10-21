import { memo, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { filterEmojiCatalog, getFrequentEmojis, isCustomEmojiUrl, recordEmojiUsage } from "@chatter/core/emojiCatalog";
import { Sheet, useSheetWidth } from "@/ui/Sheet";
import { T } from "@/ui/primitives";
import { UI_HEADING } from "@/ui/roles";
import { serverImage } from "@/ui/media";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * Pick an emoji: search, the ones used most, the room's own, then the
 * categories — the web picker's catalogue (@chatter/core/emojiCatalog).
 */
export function EmojiPickerSheet({
  open,
  onClose,
  onPick,
  roomCustomEmojis,
  emojiAliases,
  title = "Emoji",
}: {
  title?: string;
  open: boolean;
  onClose(): void;
  onPick(emoji: string): void;
  roomCustomEmojis?: string[];
  emojiAliases?: Record<string, string>;
}) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const width = useSheetWidth();
  const [search, setSearch] = useState("");
  const frequent = useMemo(() => (open ? getFrequentEmojis() : []), [open]);
  const { categories, custom } = useMemo(
    () => filterEmojiCatalog(search, roomCustomEmojis, emojiAliases),
    [search, roomCustomEmojis, emojiAliases],
  );
  // Cells sized so a row fills the sheet.
  const columns = Math.max(7, Math.floor((width - 24) / 46));
  const cell = (width - 24) / columns;

  const pick = (emoji: string) => {
    recordEmojiUsage(emoji);
    onPick(emoji);
    setSearch("");
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View style={{ height: Math.round(height * 0.55) }}>
        <View className="px-3 pb-2 pt-2">
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search emoji…"
            placeholderTextColor={colors["muted-foreground"]}
            autoCorrect={false}
            autoCapitalize="none"
            // EmojiPicker's search box.
            className="rounded border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground"
          />
        </View>
        <ScrollView contentContainerClassName="px-3 pb-6" keyboardShouldPersistTaps="handled">
          {!search && frequent.length > 0 && <Section title="Frequently used" emojis={frequent} cell={cell} onPick={pick} />}
          {custom.length > 0 && <Section title="Room" emojis={custom} cell={cell} onPick={pick} />}
          {categories.map(([name, emojis]) => (
            <Section key={name} title={name} emojis={emojis} cell={cell} onPick={pick} />
          ))}
          {search && categories.length === 0 && custom.length === 0 ? (
            <T className="py-4 text-center text-sm text-muted-foreground">No emoji found</T>
          ) : null}
        </ScrollView>
      </View>
    </Sheet>
  );
}

const Section = memo(function Section({
  title,
  emojis,
  cell,
  onPick,
}: {
  title: string;
  emojis: string[];
  cell: number;
  onPick(emoji: string): void;
}) {
  return (
    <View className="mb-3">
      <T className={`${UI_HEADING} mb-1`}>{title}</T>
      <View className="flex-row flex-wrap">
        {emojis.map((e) => (
          <Pressable
            key={e}
            onPress={() => onPick(e)}
            accessibilityLabel={isCustomEmojiUrl(e) ? "custom emoji" : e}
            style={{ width: cell, height: cell }}
            className="items-center justify-center rounded active:bg-accent"
          >
            <EmojiGlyph emoji={e} size={Math.round(cell * 0.6)} />
          </Pressable>
        ))}
      </View>
    </View>
  );
});

/** An emoji: a character, or a room's custom emoji drawn from its URL. */
export function EmojiGlyph({ emoji, size = 22 }: { emoji: string; size?: number }) {
  if (isCustomEmojiUrl(emoji)) {
    return <Image source={serverImage(emoji)} style={{ width: size, height: size }} contentFit="contain" />;
  }
  return <T style={{ fontSize: size * 0.9, lineHeight: size * 1.15, fontFamily: undefined }}>{emoji}</T>;
}
