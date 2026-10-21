import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Plus, Trash2 } from "lucide-react-native";
import { MAX_FORUM_TAGS, MAX_TAG_NAME, apiSetForumTags, type ForumTag } from "@chatter/core/api";
import { useChatter } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { ColorPickerSheet } from "@/components/ColorPickerSheet";
import { TagChip } from "@/components/forum/ForumParts";
import { Button } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Icon, T } from "@/ui/primitives";
import { UI_HINT } from "@/ui/roles";
import { TextField } from "@/ui/settings";

type DraftTag = { tag_id?: string; name: string; color: string; key: string };

let draftKey = 0;
const toDraft = (t: ForumTag): DraftTag => ({ ...t, key: t.tag_id });

/**
 * Setting up the tags a forum channel offers — the web's
 * ManageForumTagsDialog: a name and a colour each, up to twenty, saved
 * whole. A tag removed here comes off every post wearing it; a rename reaches
 * every post too, since posts hold the tag rather than its name.
 */
export default function ForumTags() {
  const { room, channel } = useLocalSearchParams<{ room: string; channel: string }>();
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const forum = room === state.currentRoomId ? state.channels.find((c) => c.channel_id === channel) : undefined;
  const [draft, setDraft] = useState<DraftTag[]>(() => (forum?.forum_tags ?? []).map(toDraft));
  const [picking, setPicking] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (key: string, patch: Partial<DraftTag>) => setDraft((d) => d.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const pickingTag = draft.find((t) => t.key === picking);

  const save = async () => {
    const cleaned = draft.map((t) => ({ ...t, name: t.name.trim() }));
    if (cleaned.some((t) => !t.name)) {
      showToast({ tone: "error", message: "Every tag needs a name" });
      return;
    }
    if (!room || !channel) return;
    setSaving(true);
    try {
      // The channel list picks the new set up from the update broadcast.
      await apiSetForumTags(
        room,
        channel,
        cleaned.map(({ tag_id, name, color }) => ({ tag_id, name, color })),
      );
      router.back();
    } catch (e) {
      showToast({ tone: "error", message: e instanceof Error ? e.message : "Failed to save tags" });
      setSaving(false);
    }
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader
        title="Forum tags"
        subtitle={forum ? `#${forum.name}` : undefined}
        right={
          <Button size="sm" className="mr-1" disabled={saving} onPress={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        }
      />
      <KeyboardAwareScrollView
        bottomOffset={16}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        contentContainerClassName="gap-3 p-4"
      >
        <T className={UI_HINT}>The tags people can put on their posts in this forum.</T>

        {draft.length === 0 ? <T className="text-sm text-muted-foreground">No tags yet.</T> : null}
        {draft.map((t) => (
          <View key={t.key} className="flex-row items-center gap-2">
            <Pressable
              onPress={() => setPicking(t.key)}
              accessibilityRole="button"
              accessibilityLabel={`Colour for ${t.name || "tag"}`}
              className="size-10 items-center justify-center rounded-md border border-input"
            >
              <View
                className={t.color ? undefined : "border border-dashed border-muted-foreground"}
                style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: t.color || "transparent" }}
              />
            </Pressable>
            <TextField
              className="h-10 flex-1"
              value={t.name}
              maxLength={MAX_TAG_NAME}
              placeholder="Tag name"
              onChangeText={(name) => update(t.key, { name })}
            />
            {t.color ? (
              <Pressable onPress={() => update(t.key, { color: "" })} accessibilityRole="button" accessibilityLabel="Use no colour" hitSlop={4} className="px-1">
                <T className="text-3xs text-muted-foreground">Clear</T>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setDraft((d) => d.filter((x) => x.key !== t.key))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${t.name || "tag"}`}
              hitSlop={4}
              className="size-10 items-center justify-center rounded-md active:bg-destructive/10"
            >
              <Icon as={Trash2} size={17} tone="destructive" />
            </Pressable>
          </View>
        ))}

        {draft.length < MAX_FORUM_TAGS ? (
          <Button
            variant="outline"
            icon={Plus}
            className="self-start"
            onPress={() => setDraft((d) => [...d, { name: "", color: "", key: `new-${++draftKey}` }])}
          >
            Add tag
          </Button>
        ) : (
          <T className={UI_HINT}>A forum can offer {MAX_FORUM_TAGS} tags.</T>
        )}

        {draft.some((t) => t.name.trim()) ? (
          <View className="gap-2 pt-2">
            <T className={UI_HINT}>As they will look</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-1">
              {draft
                .filter((t) => t.name.trim())
                .map((t) => (
                  <TagChip key={t.key} tag={{ tag_id: t.key, name: t.name.trim(), color: t.color }} />
                ))}
            </ScrollView>
          </View>
        ) : null}
      </KeyboardAwareScrollView>

      <ColorPickerSheet
        open={!!pickingTag}
        title={pickingTag?.name ? `Colour for ${pickingTag.name}` : "Tag colour"}
        value={pickingTag?.color || "#888888"}
        onClose={() => setPicking(null)}
        onPick={(hex) => {
          if (picking) update(picking, { color: hex });
          setPicking(null);
        }}
      />
    </View>
  );
}
