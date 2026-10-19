import { useState } from "react";
import { Pressable, View } from "react-native";
import { SmilePlus } from "lucide-react-native";
import { MAX_POST_TAGS, apiUploadFile, forumFiles, forumImages, forumVideos, type ForumTag } from "@chatter/core/api";
import { sortForumAttachments } from "@chatter/core/mediaTypes";
import { nativeUploadSource, type PickedFile } from "@/platform/uploads";
import type { BodyMedia } from "@chatter/core/messageFormat";
import { readableOn } from "@chatter/core/color";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useTheme } from "@/theme/ThemeProvider";
import { showToast } from "@/platform/toast";
import { EmojiGlyph, EmojiPickerSheet } from "@/components/EmojiPickerSheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";

/**
 * The pieces the forum screens share — the web's ForumTags, ForumReactions
 * and the gallery's split of a post's attachments.
 */

/** "just now", "5m ago", "3h ago", then the date (ForumPostCard's). */
export function forumTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Upload what was staged, in order, and sort it into a post's three lists.
 * Stops at the first failure — posting the rest would quietly drop what was
 * picked — and names the file that failed.
 */
export async function uploadForumAttachments(
  files: PickedFile[],
  onProgress?: (index: number, pct: number) => void,
): Promise<{ imageUrls: string[]; videoUrls: string[]; fileUrls: string[] }> {
  const uploaded: { file: { name: string; type: string }; url: string }[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const { url } = await apiUploadFile(nativeUploadSource(file), (pct) => onProgress?.(i, pct));
      uploaded.push({ file: { name: file.name, type: file.type ?? "" }, url });
    } catch {
      throw new Error(`${file.name} could not be uploaded`);
    }
  }
  return sortForumAttachments(uploaded);
}

const AUDIO = /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i;

/** A post's or reply's attachments in the shape the message media draws. */
export function forumMedia(item: { image_url?: string; image_urls?: string[]; video_urls?: string[]; file_urls?: string[] }): BodyMedia {
  const files = forumFiles(item);
  return {
    images: forumImages(item),
    videos: forumVideos(item),
    audios: files.filter((f) => AUDIO.test(f)),
    files: files.filter((f) => !AUDIO.test(f)),
    links: [],
    youtubeIds: [],
    messageLinks: [],
    forumLinks: [],
  };
}

/**
 * One tag as a chip, tinted with its colour when it has one — adapted to this
 * theme the way the web does it: the text at 4.5:1 against the surfaces, the
 * edge at 3:1, the tint from the adapted text.
 */
export function TagChip({
  tag,
  selected,
  onPress,
  size = "sm",
}: {
  tag: ForumTag;
  selected?: boolean;
  onPress?: () => void;
  size?: "xs" | "sm";
}) {
  const { colors } = useTheme();
  const surfaces = [colors.background, colors.card];
  const text = tag.color ? readableOn(tag.color, surfaces) : "";
  const style = text
    ? { borderColor: readableOn(tag.color, surfaces, 3), backgroundColor: `${text}${selected === false ? "00" : "1f"}` }
    : undefined;
  const box = cn(
    "flex-row items-center rounded-full border",
    size === "xs" ? "px-1.5 py-0" : "px-2.5 py-1",
    !tag.color && (selected ? "border-foreground/30 bg-accent" : "border-border"),
    selected === false && "opacity-60",
  );
  const label = (
    <T
      className={cn("font-medium", size === "xs" ? "text-3xs" : "text-xs", !tag.color && !selected && "text-muted-foreground")}
      style={text ? { color: text } : undefined}
      numberOfLines={1}
    >
      {tag.name}
    </T>
  );
  if (!onPress) {
    return (
      <View className={box} style={style}>
        {label}
      </View>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} className={box} style={style}>
      {label}
    </Pressable>
  );
}

/** The tags a post wears, in the channel's order; a dropped one is skipped. */
export function TagList({ tagIds, tags, size = "sm" }: { tagIds?: string[]; tags?: ForumTag[]; size?: "xs" | "sm" }) {
  const worn = (tags ?? []).filter((t) => tagIds?.includes(t.tag_id));
  if (worn.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1">
      {worn.map((t) => (
        <TagChip key={t.tag_id} tag={t} size={size} />
      ))}
    </View>
  );
}

/** Choosing a post's tags from what its channel offers (ForumTagPicker). */
export function TagPicker({ tags, value, onChange }: { tags: ForumTag[]; value: string[]; onChange(next: string[]): void }) {
  if (tags.length === 0) return null;
  const full = value.length >= MAX_POST_TAGS;
  return (
    <View className="gap-1.5">
      <T className="text-xs font-medium text-muted-foreground">Tags (up to {MAX_POST_TAGS})</T>
      <View className="flex-row flex-wrap gap-1">
        {tags.map((t) => {
          const on = value.includes(t.tag_id);
          return (
            <TagChip
              key={t.tag_id}
              tag={t}
              selected={on}
              onPress={() => {
                if (on) onChange(value.filter((id) => id !== t.tag_id));
                else if (!full) onChange([...value, t.tag_id]);
                else showToast({ tone: "error", message: `A post can have at most ${MAX_POST_TAGS} tags` });
              }}
            />
          );
        })}
      </View>
    </View>
  );
}

/**
 * A post's or reply's reactions and the button that adds one. Its id is its
 * reaction key, so it rides the message machinery: the store's
 * messageReactions, which the broadcast updates, wins over what it arrived
 * carrying.
 */
export function ForumReactions({
  targetId,
  initial,
  compact,
}: {
  targetId: string;
  initial?: Record<string, string[]>;
  compact?: boolean;
}) {
  const state = useChatter();
  const { addReaction } = useChatterActions();
  const [picking, setPicking] = useState(false);
  const reactions = state.messageReactions[targetId] ?? initial ?? {};
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const toggle = (emoji: string) => void addReaction(targetId, emoji, reactions);
  return (
    <View className="flex-row flex-wrap items-center gap-1">
      {entries.map(([emoji, users]) => {
        const mine = !!state.userId && users.includes(state.userId);
        return (
          <Pressable
            key={emoji}
            onPress={() => toggle(emoji)}
            accessibilityRole="button"
            accessibilityLabel={`${emoji} ${users.length}${mine ? ", you reacted" : ""}`}
            className={cn(
              "flex-row items-center gap-1 rounded-full border",
              compact ? "px-1.5 py-0.5" : "min-h-7 px-2 py-0.5",
              mine ? "border-primary/50 bg-primary/10" : "border-border active:bg-accent",
            )}
          >
            <EmojiGlyph emoji={emoji} size={compact ? 13 : 17} />
            <T className={cn("font-medium text-muted-foreground", compact ? "text-3xs" : "text-sm")}>{users.length}</T>
          </Pressable>
        );
      })}
      <Pressable
        onPress={() => setPicking(true)}
        accessibilityRole="button"
        accessibilityLabel="Add a reaction"
        hitSlop={6}
        className={cn("items-center justify-center rounded-full border border-border active:bg-accent", compact ? "h-6 w-7" : "h-7 w-8")}
      >
        <Icon as={SmilePlus} size={compact ? 12 : 15} />
      </Pressable>
      <EmojiPickerSheet
        open={picking}
        onClose={() => setPicking(false)}
        title="React"
        roomCustomEmojis={room?.custom_emojis}
        emojiAliases={room?.emoji_aliases}
        onPick={(emoji) => {
          setPicking(false);
          toggle(emoji);
        }}
      />
    </View>
  );
}
