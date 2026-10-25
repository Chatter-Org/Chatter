import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Link,
  MoreVertical,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react-native";
import {
  apiCreateForumComment,
  apiDeleteForumComment,
  apiDeleteForumPost,
  apiEditForumComment,
  apiGetForumPost,
  type ForumComment,
  type ForumPost,
} from "@chatter/core/api";
import { FORUM_EVENTS, applyForumThreadEvent, forumMarkdownToChat, type ForumEventDetail, type ForumThreadState } from "@chatter/core/forum";
import {
  MAX_THREAD_INDENT,
  buildCommentThread,
  countReplies,
  loadThreadOrder,
  storeThreadOrder,
  type ForumCommentNode,
  type ThreadOrder,
} from "@chatter/core/forumThread";
import { forumLinkFor, forumReplyLinkFor } from "@chatter/core/forumLinks";
import { displayUserId } from "@chatter/core/utils";
import { useChatter } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { MessageBody } from "@/components/MessageBody";
import { MessageMedia } from "@/components/MessageMedia";
import { AttachSheet, MAX_ATTACHMENTS } from "@/components/AttachSheet";
import { Tile } from "@/components/Composer";
import { ComposerSuggestions, useComposerSuggestions } from "@/components/ComposerSuggestions";
import { useShowProfile } from "@/components/ProfileSheet";
import { useMessageRows } from "@/components/useMessageRows";
import { ForumReactions, TagList, forumMedia, forumTime, uploadForumAttachments } from "@/components/forum/ForumParts";
import { on } from "@/platform/events";
import { showToast } from "@/platform/toast";
import type { PickedFile } from "@/platform/uploads";
import { useTheme } from "@/theme/ThemeProvider";
import { Sheet, SheetRow } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING, UI_META } from "@/ui/roles";

/** A row of the flattened thread: a comment at its depth, or the note that
 *  stands for a folded run of replies. */
type Row = { node: ForumCommentNode; hidden: number };

/**
 * A forum post — the web's ForumPostView as a screen: the post, then the
 * discussion threaded under it, and a composer at the bottom that answers the
 * post or, after "Reply", one comment. Hold a comment for its other actions.
 */
export default function ForumPostScreen() {
  const params = useLocalSearchParams<{ room: string; post: string; channel?: string }>();
  const roomId = params.room;
  const postId = params.post;
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const showProfile = useShowProfile();
  const { formatOptions } = useMessageRows();
  const channel = state.channels.find((c) => c.channel_id === params.channel);
  const tags = channel?.forum_tags ?? [];
  const myRole = state.roomMembers.find((m) => m.userId === state.userId)?.role;
  const isOwnerOrMod = myRole === "owner" || myRole === "moderator";

  const [thread, setThread] = useState<ForumThreadState>({ post: null, comments: [] });
  const [missing, setMissing] = useState(false);
  const [order, setOrder] = useState<ThreadOrder>(loadThreadOrder);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<ForumComment | null>(null);
  const [editing, setEditing] = useState<ForumComment | null>(null);
  const [acting, setActing] = useState<ForumComment | null>(null);
  const [postMenu, setPostMenu] = useState(false);
  const [body, setBody] = useState("");
  const [staged, setStaged] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [attaching, setAttaching] = useState(false);
  const [sending, setSending] = useState(false);
  const [landing, setLanding] = useState<string | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const mentions = useComposerSuggestions(body, setBody, { emoji: false });
  const listRef = useRef<FlatList<Row>>(null);

  const keyboard = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, keyboard.height.value + insets.bottom) }] }));

  useEffect(() => {
    apiGetForumPost(roomId, postId)
      .then((d) => setThread({ post: d.post, comments: d.comments }))
      .catch(() => setMissing(true));
  }, [roomId, postId]);

  // The socket, through the shared rules (core/forum.ts).
  const onForumEvent = useEffectEvent((type: (typeof FORUM_EVENTS)[number], detail: ForumEventDetail) => {
    const next = applyForumThreadEvent(thread, type, detail, postId);
    if (next.gone) {
      showToast({ message: "This post was deleted" });
      router.back();
      return;
    }
    if (next !== thread) setThread(next);
  });
  useEffect(() => {
    const offs = FORUM_EVENTS.map((type) => on<ForumEventDetail>(type, (detail) => onForumEvent(type, detail)));
    return () => offs.forEach((off) => off());
  }, [postId]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: ForumCommentNode[]) => {
      for (const node of nodes) {
        const isFolded = folded.has(node.comment.comment_id);
        out.push({ node, hidden: isFolded ? countReplies(node) : 0 });
        if (!isFolded) walk(node.replies);
      }
    };
    walk(buildCommentThread(thread.comments, order));
    return out;
  }, [thread.comments, order, folded]);

  // Take the writer to what they just wrote: a reply lands beside its parent,
  // which is rarely the bottom.
  useEffect(() => {
    if (!landing) return;
    const index = rows.findIndex((r) => r.node.comment.comment_id === landing);
    if (index < 0) return;
    requestAnimationFrame(() => {
      setLanding(null);
      listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    });
  }, [landing, rows]);

  const toggleFold = useCallback((id: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const flipOrder = () => {
    const next = order === "oldest" ? "newest" : "oldest";
    setOrder(next);
    storeThreadOrder(next);
  };

  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);

  const startReply = (comment: ForumComment) => {
    setEditing(null);
    setReplyingTo(comment);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const startEdit = (comment: ForumComment) => {
    setReplyingTo(null);
    setStaged([]);
    setEditing(comment);
    setBody(comment.body);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const cancelCompose = () => {
    setReplyingTo(null);
    if (editing) {
      setEditing(null);
      setBody("");
    }
  };

  const send = async () => {
    if (sending) return;
    if (editing) {
      if (!body.trim()) return;
      setSending(true);
      try {
        await apiEditForumComment(roomId, postId, editing.comment_id, body.trim());
        setEditing(null);
        setBody("");
      } catch (e) {
        showToast({ tone: "error", message: e instanceof Error ? e.message : "Failed to edit comment" });
      } finally {
        setSending(false);
      }
      return;
    }
    if (!body.trim() && staged.length === 0) return;
    setSending(true);
    try {
      const { imageUrls, videoUrls, fileUrls } = await uploadForumAttachments(staged, (i, pct) => setProgress((p) => ({ ...p, [i]: pct })));
      // The server wants a body; a reply that is only media says so.
      const count = imageUrls.length + videoUrls.length + fileUrls.length;
      const text = body.trim() || (count > 1 ? `(${count} attachments)` : count === 1 ? "(attachment)" : "");
      const { comment_id } = await apiCreateForumComment(roomId, postId, text, imageUrls, videoUrls, replyingTo?.comment_id, fileUrls);
      setBody("");
      setStaged([]);
      setReplyingTo(null);
      setLanding(comment_id);
    } catch (e) {
      // Everything stays staged, to send again as it stands.
      showToast({ tone: "error", message: e instanceof Error ? e.message : "Failed to post comment" });
    } finally {
      setSending(false);
      setProgress({});
    }
  };

  const post = thread.post;
  if (!post) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background" style={{ paddingTop: insets.top }}>
        {missing ? <T className="text-sm text-muted-foreground">This post is not available.</T> : <ActivityIndicator />}
        {missing ? (
          <Pressable onPress={() => router.back()}>
            <T className="text-sm underline">Back</T>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const canManagePost = post.author === state.userId || isOwnerOrMod;

  const header = (
    <View>
      <View className="border-b border-border/50 px-3 pb-3 pt-3">
        <Pressable onPress={() => showProfile(post.author)} className="flex-row items-center gap-2 self-start">
          <Avatar userId={post.author} name={nameOf(post.author)} url={state.userPresence[post.author]?.avatarUrl} size={31} />
          <View>
            <T className="text-sm font-semibold">{nameOf(post.author)}</T>
            <T className={UI_META}>
              {forumTime(post.created_at)}
              {post.edited ? " · (edited)" : ""}
            </T>
          </View>
        </Pressable>
        <T className="mt-2 text-lg font-semibold leading-snug">{post.title}</T>
        <View className="mt-1">
          <TagList tagIds={post.tags} tags={tags} />
        </View>
        {post.body ? (
          <View className="mt-2">
            <MessageBody body={forumMarkdownToChat(post.body)} options={formatOptions} />
          </View>
        ) : null}
        <MessageMedia media={forumMedia(post)} />
        <View className="mt-2">
          <ForumReactions targetId={post.post_id} initial={post.reactions} />
        </View>
      </View>
      <View className="flex-row items-center gap-2 px-3 py-2">
        <T className={UI_HEADING}>
          {post.comment_count} {post.comment_count === 1 ? "reply" : "replies"}
        </T>
        <View className="h-px flex-1 bg-border" />
        <Pressable onPress={flipOrder} accessibilityRole="button" className="flex-row items-center gap-1 rounded px-1 py-0.5 active:bg-accent">
          <Icon as={ArrowUpDown} size={12} />
          <T className="text-xs text-muted-foreground">{order === "oldest" ? "Oldest first" : "Newest first"}</T>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back to the forum" className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent">
          <Icon as={ArrowLeft} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold" numberOfLines={1}>
            {post.title}
          </T>
          {channel ? (
            <T className={UI_META} numberOfLines={1}>
              {channel.name}
            </T>
          ) : null}
        </View>
        <Pressable onPress={() => setPostMenu(true)} accessibilityRole="button" accessibilityLabel="Post options" className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent">
          <Icon as={MoreVertical} size={20} />
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.node.comment.comment_id}
        ListHeaderComponent={header}
        ListEmptyComponent={<T className="px-3 py-6 text-center text-sm text-muted-foreground">No replies yet. Start the discussion.</T>}
        ListFooterComponent={<View style={{ height: 12 }} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onScrollToIndexFailed={({ index }) => setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true }), 250)}
        renderItem={({ item }) => (
          <CommentRow
            row={item}
            nameOf={nameOf}
            onReply={startReply}
            onHold={setActing}
            onToggleFold={toggleFold}
            onProfile={showProfile}
            formatOptions={formatOptions}
          />
        )}
      />

      <Animated.View style={[lift, { paddingBottom: insets.bottom + 6 }]} className="border-t border-border bg-background px-2 pt-1.5">
        {replyingTo || editing ? (
          <View className="mb-1.5 flex-row items-center gap-1.5 px-1">
            <Icon as={editing ? Pencil : CornerUpLeft} size={13} />
            <T className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              {editing ? "Editing your reply" : `Replying to ${replyingTo!.deleted ? "a deleted reply" : nameOf(replyingTo!.author)}`}
            </T>
            <Pressable onPress={cancelCompose} hitSlop={8} accessibilityLabel="Cancel">
              <Icon as={X} size={14} />
            </Pressable>
          </View>
        ) : null}
        <ComposerSuggestions items={mentions.items} onPick={mentions.pick} />
        {staged.length > 0 ? (
          <View className="mb-1.5 flex-row flex-wrap gap-2 px-1">
            {staged.map((f, i) => (
              <Tile
                key={`${f.uri}-${i}`}
                name={f.name}
                previewUri={f.type?.startsWith("image/") ? f.uri : null}
                status={sending ? "uploading" : undefined}
                pct={progress[i] ?? 0}
                onRemove={sending ? undefined : () => setStaged((s) => s.filter((_, j) => j !== i))}
              />
            ))}
          </View>
        ) : null}
        <View className="flex-row items-end gap-1.5">
          {!editing ? (
            <Pressable
              onPress={() => setAttaching(true)}
              disabled={staged.length >= MAX_ATTACHMENTS}
              accessibilityRole="button"
              accessibilityLabel="Attach files"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-accent"
            >
              <Icon as={Plus} size={22} />
            </Pressable>
          ) : null}
          <TextInput
            ref={inputRef}
            value={body}
            onChangeText={setBody}
            {...mentions.input}
            placeholder={replyingTo ? "Write a reply..." : "Write a comment..."}
            placeholderTextColor={colors["muted-foreground"]}
            multiline
            maxLength={4000}
            className="max-h-32 min-h-10 flex-1 rounded-2xl border border-input px-3 py-2 font-mono text-sm text-foreground"
          />
          <Pressable
            onPress={() => void send()}
            disabled={sending || (!body.trim() && staged.length === 0)}
            accessibilityRole="button"
            accessibilityLabel={editing ? "Save" : "Send"}
            className={cn("h-10 w-10 items-center justify-center rounded-full bg-primary", (sending || (!body.trim() && staged.length === 0)) && "opacity-40")}
          >
            {sending ? <ActivityIndicator size="small" color={colors["primary-foreground"]} /> : <Icon as={Send} size={17} tone="primary-foreground" />}
          </Pressable>
        </View>
      </Animated.View>

      <AttachSheet
        open={attaching}
        onClose={() => setAttaching(false)}
        room={MAX_ATTACHMENTS - staged.length}
        onPicked={(files) => setStaged((s) => [...s, ...files].slice(0, MAX_ATTACHMENTS))}
      />

      <Sheet open={postMenu} onClose={() => setPostMenu(false)} title={post.title}>
        <View className="pb-1">
          <SheetRow
            icon={Link}
            label="Copy post link"
            onPress={() => {
              setPostMenu(false);
              void Clipboard.setStringAsync(forumLinkFor(post.post_id));
              showToast({ message: "Post link copied" });
            }}
          />
          {post.author === state.userId ? (
            <SheetRow
              icon={Pencil}
              label="Edit post"
              onPress={() => {
                setPostMenu(false);
                router.push({ pathname: "/forum-new", params: { room: roomId, channel: params.channel ?? "", edit: post.post_id } });
              }}
            />
          ) : null}
          {canManagePost ? (
            <SheetRow
              icon={Trash2}
              label="Delete post"
              destructive
              onPress={() => {
                setPostMenu(false);
                Alert.alert("Delete this post?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () =>
                      void apiDeleteForumPost(roomId, post.post_id).catch((e) =>
                        showToast({ tone: "error", message: e instanceof Error ? e.message : "Failed to delete post" }),
                      ),
                  },
                ]);
              }}
            />
          ) : null}
        </View>
      </Sheet>

      <CommentActions
        comment={acting}
        post={post}
        mine={!!acting && acting.author === state.userId}
        canDelete={!!acting && (acting.author === state.userId || isOwnerOrMod)}
        onClose={() => setActing(null)}
        onReply={startReply}
        onEdit={startEdit}
        roomId={roomId}
      />
    </View>
  );
}

/** One comment: the rail for its depth, who and when, what it says, its
 *  media and reactions, and Reply. A folded one says how many it hides. */
function CommentRow({
  row,
  nameOf,
  onReply,
  onHold,
  onToggleFold,
  onProfile,
  formatOptions,
}: {
  row: Row;
  nameOf(id: string): string;
  onReply(c: ForumComment): void;
  onHold(c: ForumComment): void;
  onToggleFold(id: string): void;
  onProfile(id: string): void;
  formatOptions: ReturnType<typeof useMessageRows>["formatOptions"];
}) {
  const state = useChatter();
  const { node, hidden } = row;
  const c = node.comment;
  const indent = Math.min(node.depth, MAX_THREAD_INDENT);
  const hasReplies = node.replies.length > 0;
  return (
    <View style={{ paddingLeft: 12 + indent * 14 }} className="pr-3">
      <Pressable
        onLongPress={() => !c.deleted && onHold(c)}
        delayLongPress={350}
        className={cn("py-2", indent > 0 && "border-l-2 border-border pl-2.5")}
      >
        {c.deleted ? (
          <T className="text-sm italic text-muted-foreground">[deleted]</T>
        ) : (
          <>
            <Pressable onPress={() => onProfile(c.author)} className="flex-row items-center gap-2 self-start">
              <Avatar userId={c.author} name={nameOf(c.author)} url={state.userPresence[c.author]?.avatarUrl} size={22} textClassName="text-3xs" />
              <T className="text-sm font-semibold">{nameOf(c.author)}</T>
              <T className="text-xs text-muted-foreground">
                {forumTime(c.created_at)}
                {c.edited ? " · edited" : ""}
              </T>
            </Pressable>
            <View className="mt-1">
              <MessageBody body={forumMarkdownToChat(c.body)} options={formatOptions} />
              <MessageMedia media={forumMedia(c)} />
            </View>
          </>
        )}
        <View className="mt-1.5 flex-row flex-wrap items-center gap-3">
          {!c.deleted ? <ForumReactions targetId={c.comment_id} initial={c.reactions} compact /> : null}
          {!c.deleted ? (
            <Pressable onPress={() => onReply(c)} hitSlop={6} accessibilityRole="button" className="flex-row items-center gap-1">
              <Icon as={CornerUpLeft} size={13} />
              <T className="text-xs text-muted-foreground">Reply</T>
            </Pressable>
          ) : null}
          {hasReplies ? (
            <Pressable onPress={() => onToggleFold(c.comment_id)} hitSlop={6} accessibilityRole="button" className="flex-row items-center gap-1">
              <Icon as={hidden ? ChevronRight : ChevronDown} size={13} />
              <T className="text-xs text-muted-foreground">
                {hidden ? `${hidden} ${hidden === 1 ? "reply" : "replies"} hidden` : "Hide replies"}
              </T>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function CommentActions({
  comment,
  post,
  mine,
  canDelete,
  onClose,
  onReply,
  onEdit,
  roomId,
}: {
  comment: ForumComment | null;
  post: ForumPost;
  mine: boolean;
  canDelete: boolean;
  onClose(): void;
  onReply(c: ForumComment): void;
  onEdit(c: ForumComment): void;
  roomId: string;
}) {
  return (
    <Sheet open={!!comment} onClose={onClose} title="Reply">
      {comment ? (
        <View className="pb-1">
          <SheetRow icon={CornerUpLeft} label="Reply" onPress={() => (onClose(), onReply(comment))} />
          <SheetRow icon={Copy} label="Copy text" onPress={() => (onClose(), void Clipboard.setStringAsync(comment.body))} />
          <SheetRow
            icon={Link}
            label="Copy reply link"
            onPress={() => {
              onClose();
              void Clipboard.setStringAsync(forumReplyLinkFor(post.post_id, comment.comment_id));
              showToast({ message: "Reply link copied" });
            }}
          />
          {mine ? <SheetRow icon={Pencil} label="Edit" onPress={() => (onClose(), onEdit(comment))} /> : null}
          {canDelete ? (
            <SheetRow
              icon={Trash2}
              label="Delete"
              destructive
              onPress={() => {
                onClose();
                Alert.alert("Delete this comment?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () =>
                      void apiDeleteForumComment(roomId, post.post_id, comment.comment_id).catch((e) =>
                        showToast({ tone: "error", message: e instanceof Error ? e.message : "Failed to delete comment" }),
                      ),
                  },
                ]);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
