import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Paperclip, X } from "lucide-react-native";
import { apiCreateForumPost, apiEditForumPost, apiGetForumPost } from "@chatter/core/api";
import { useChatter } from "@/state/ChatterProvider";
import { AttachSheet, MAX_ATTACHMENTS } from "@/components/AttachSheet";
import { Tile } from "@/components/Composer";
import { TagPicker, uploadForumAttachments } from "@/components/forum/ForumParts";
import { openForumPost } from "@/components/forum/ForumView";
import { showToast } from "@/platform/toast";
import type { PickedFile } from "@/platform/uploads";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { UI_HINT, UI_META } from "@/ui/roles";
import { Field, TextField } from "@/ui/settings";

/**
 * Writing a forum post — the web's CreatePostDialog as a screen: a title, the
 * body, the channel's tags, and up to ten attachments from the gallery, the
 * camera or files, uploaded in order when it is posted. With `?edit=` it
 * edits a post's title, body and tags instead (attachments stay as they are,
 * as on the web).
 */
export default function NewForumPost() {
  const params = useLocalSearchParams<{ room: string; channel?: string; edit?: string }>();
  const roomId = params.room;
  const channelId = params.channel || null;
  const editId = params.edit || null;
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const tags = channel?.forum_tags ?? [];

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [attaching, setAttaching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(!editId);

  useEffect(() => {
    if (!editId) return;
    apiGetForumPost(roomId, editId)
      .then(({ post }) => {
        setTitle(post.title);
        setBody(post.body);
        setSelectedTags(post.tags ?? []);
        setLoaded(true);
      })
      .catch(() => {
        showToast({ tone: "error", message: "That post is not available" });
        router.back();
      });
  }, [roomId, editId]);

  // Checked as they are picked: uploads run in turn, so one the server will
  // refuse would otherwise be found out only after the ones before it went.
  const stage = (picked: PickedFile[]) => {
    const limit = state.uploadLimitBytes;
    const small = limit > 0 ? picked.filter((f) => (f.size ?? 0) <= limit) : picked;
    const tooBig = picked.length - small.length;
    if (tooBig > 0) {
      const mb = Math.round(limit / 1024 / 1024);
      showToast({ tone: "error", message: tooBig === 1 ? `That file is over the ${mb} MB limit` : `${tooBig} files are over the ${mb} MB limit` });
    }
    setFiles((prev) => [...prev, ...small].slice(0, MAX_ATTACHMENTS));
  };

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (editId) {
        await apiEditForumPost(roomId, editId, title.trim(), body, selectedTags);
        router.back();
        return;
      }
      const { imageUrls, videoUrls, fileUrls } = await uploadForumAttachments(files, (i, pct) => setProgress((p) => ({ ...p, [i]: pct })));
      const { post_id } = await apiCreateForumPost(roomId, title.trim(), body, imageUrls, videoUrls, fileUrls, channelId, selectedTags);
      router.back();
      openForumPost(roomId, post_id, channelId);
    } catch (e) {
      // Everything stays as it was, to post again.
      showToast({ tone: "error", message: e instanceof Error ? e.message : editId ? "Failed to edit post" : "Failed to create post" });
      setSubmitting(false);
      setProgress({});
    }
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Cancel" className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent">
          <Icon as={X} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold">{editId ? "Edit post" : "Create New Post"}</T>
          {channel ? (
            <T className={UI_META} numberOfLines={1}>
              {channel.name}
            </T>
          ) : null}
        </View>
        <Button size="sm" disabled={!title.trim() || submitting || !loaded} onPress={() => void submit()}>
          {submitting ? (editId ? "Saving..." : "Creating...") : editId ? "Save" : "Post"}
        </Button>
      </View>

      {!loaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-4 p-4"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {!editId ? <T className={UI_HINT}>Share something with the community.</T> : null}
          <Field label="Title">
            <TextField value={title} onChangeText={setTitle} placeholder="Post title" maxLength={200} autoFocus={!editId} />
          </Field>
          <Field label="Body (Optional)">
            <TextField value={body} onChangeText={setBody} placeholder="Write your post content..." maxLength={4000} multiline className="min-h-28" />
          </Field>
          <TagPicker tags={tags} value={selectedTags} onChange={setSelectedTags} />
          {!editId ? (
            <Field label={files.length > 0 ? `Attachments (Optional) · ${files.length} of ${MAX_ATTACHMENTS}` : "Attachments (Optional)"}>
              {files.length > 0 ? (
                <View className="flex-row flex-wrap gap-2">
                  {files.map((f, i) => (
                    <Tile
                      key={`${f.uri}-${i}`}
                      name={f.name}
                      previewUri={f.type?.startsWith("image/") ? f.uri : null}
                      status={submitting ? "uploading" : undefined}
                      pct={progress[i] ?? 0}
                      onRemove={submitting ? undefined : () => setFiles((s) => s.filter((_, j) => j !== i))}
                    />
                  ))}
                </View>
              ) : null}
              <Button variant="outline" size="sm" icon={Paperclip} className="self-start" disabled={files.length >= MAX_ATTACHMENTS || submitting} onPress={() => setAttaching(true)}>
                {files.length === 0
                  ? "Add Files"
                  : files.length >= MAX_ATTACHMENTS
                    ? `${MAX_ATTACHMENTS} files is the limit`
                    : `Add more (${MAX_ATTACHMENTS - files.length} left)`}
              </Button>
            </Field>
          ) : null}
        </ScrollView>
      )}

      <AttachSheet open={attaching} onClose={() => setAttaching(false)} room={MAX_ATTACHMENTS - files.length} onPicked={stage} />
    </View>
  );
}
