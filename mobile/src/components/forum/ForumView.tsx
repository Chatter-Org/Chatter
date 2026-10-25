import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { ArrowUpDown, Check, Link, MessageSquare, Paperclip, Pin, PinOff, Play, Plus, Search, Tags, Trash2, X } from "lucide-react-native";
import {
  apiDeleteForumPost,
  apiGetForumPost,
  apiListForumPosts,
  apiPinForumPost,
  apiSearchForumPosts,
  apiUnpinForumPost,
  forumFiles,
  forumImages,
  forumVideos,
  type ForumPost,
  type ForumTag,
} from "@chatter/core/api";
import {
  FORUM_EVENTS,
  FORUM_SORT_LABELS,
  addPinnedPost,
  appendForumPage,
  applyForumListEvent,
  forumPageCursor,
  forumPlainText,
  pinnedPostToFetch,
  type ForumEventDetail,
  type ForumListView,
  type ForumSort,
} from "@chatter/core/forum";
import { forumLinkFor } from "@chatter/core/forumLinks";
import { displayUserId } from "@chatter/core/utils";
import { useChatter } from "@/state/ChatterProvider";
import { on } from "@/platform/events";
import { showToast } from "@/platform/toast";
import { useTheme } from "@/theme/ThemeProvider";
import { Sheet, SheetRow } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HINT } from "@/ui/roles";
import { ForumReactions, TagChip, TagList, forumTime } from "./ForumParts";

/** What `/forum-post` needs to open a post. */
export function openForumPost(roomId: string, postId: string, channelId: string | null) {
  router.push({ pathname: "/forum-post", params: { room: roomId, post: postId, channel: channelId ?? "" } });
}

/**
 * A forum — the web's ForumArea at phone width, where the timeline would be:
 * search, sort and tag filters over the posts, pinned ones first; a post opens
 * as a screen of its own, and "New" writes one. Pull down to refresh.
 */
export function ForumView() {
  const state = useChatter();
  const { colors } = useTheme();
  const roomId = state.currentRoomId!;
  const roomInfo = state.roomInfoMap[roomId];
  // A forum channel keeps its own posts; no channel is a room that is a forum.
  const forumChannel = state.channels.find((c) => c.channel_id === state.currentChannelId && c.channel_type === "forum");
  const channelId = forumChannel?.channel_id ?? null;
  const tags = useMemo(() => forumChannel?.forum_tags ?? [], [forumChannel?.forum_tags]);
  // Whoever set the forum up decides its tags, as does anyone who can manage
  // the room's channels (the server checks the same two things).
  const canManageTags = !!forumChannel && (forumChannel.created_by === state.userId || !!state.myPermissions?.manage_channels);
  const canPin = !!state.myPermissions?.manage_channels || !!state.myPermissions?.manage_forum_posts || (forumChannel ? forumChannel.created_by === state.userId : roomInfo?.creator === state.userId);
  const myRole = state.roomMembers.find((m) => m.userId === state.userId)?.role;
  // The role check covers a server too old to send manage_forum_posts.
  const canManagePosts = !!state.myPermissions?.manage_forum_posts || myRole === "owner" || myRole === "moderator";

  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [hasMore, setHasMore] = useState(false);
  // Loading from the start: the first page is fetched as the view mounts.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<ForumSort>("activity");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [acting, setActing] = useState<ForumPost | null>(null);

  const fetchPosts = useCallback(
    (nextSort: ForumSort, tag: string | null, before?: number) =>
      apiListForumPosts(roomId, 20, before, nextSort, channelId, tag)
        .then((data) => {
          setPosts((prev) => (before === undefined ? data.posts : appendForumPage(prev, data.posts)));
          setHasMore(data.has_more);
        })
        .catch(() => {
          // The list stays as it was.
        })
        .finally(() => setLoading(false)),
    [roomId, channelId],
  );

  const load = useCallback(
    (nextSort: ForumSort, tag: string | null, before?: number) => {
      setLoading(true);
      return fetchPosts(nextSort, tag, before);
    },
    [fetchPosts],
  );

  // A new forum starts fresh: all posts, most active first. Each room and
  // channel is its own ForumView (keyed in app/index.tsx), so the rest of the
  // state starts fresh with it.
  useEffect(() => {
    void fetchPosts("activity", null);
  }, [fetchPosts]);

  // Clearing the search goes back to the list.
  const changeQuery = (next: string) => {
    setQuery(next);
    if (!next.trim() && searching) {
      setSearching(false);
      void load(sort, tagFilter);
    }
  };

  // Search, a beat after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      setLoading(true);
      try {
        const data = await apiSearchForumPosts(roomId, q, undefined, channelId);
        setPosts(data.posts);
        setHasMore(false);
      } catch {
        // Keep what is shown.
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, roomId, channelId]);

  // The socket, through the shared rules (core/forum.ts).
  const onForumEvent = useEffectEvent((type: (typeof FORUM_EVENTS)[number], detail: ForumEventDetail, view: ForumListView) => {
    setPosts((prev) => applyForumListEvent(prev, type, detail, view));
    const fetchId = pinnedPostToFetch(posts, type, detail, view);
    if (fetchId) {
      apiGetForumPost(roomId, fetchId)
        .then(({ post }) => setPosts((prev) => addPinnedPost(prev, post, detail, view)))
        .catch(() => {});
    }
  });
  useEffect(() => {
    const view: ForumListView = { roomId, channelId, sort, tagFilter, searching };
    const offs = FORUM_EVENTS.map((type) => on<ForumEventDetail>(type, (detail) => onForumEvent(type, detail, view)));
    return () => offs.forEach((off) => off());
  }, [roomId, channelId, sort, tagFilter, searching]);

  const changeSort = (next: ForumSort) => {
    setSorting(false);
    if (next === sort) return;
    setSort(next);
    setQuery("");
    setSearching(false);
    setPosts([]);
    void load(next, tagFilter);
  };

  const changeTag = (tag: string | null) => {
    if (tag === tagFilter) return;
    setTagFilter(tag);
    setQuery("");
    setSearching(false);
    setPosts([]);
    void load(sort, tag);
  };

  const refresh = async () => {
    setRefreshing(true);
    await load(sort, tagFilter);
    setRefreshing(false);
  };

  // Search is not filtered on the server, so its results are narrowed here.
  const shown = searching && tagFilter ? posts.filter((p) => (p.tags ?? []).includes(tagFilter)) : posts;

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <View className="flex-1 flex-row items-center rounded-md border border-input pl-2.5">
          <Icon as={Search} size={15} />
          <TextInput
            value={query}
            onChangeText={changeQuery}
            placeholder="Search posts..."
            placeholderTextColor={colors["muted-foreground"]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            className="h-9 flex-1 px-2 font-mono text-sm text-foreground"
          />
          {query ? (
            <Pressable onPress={() => changeQuery("")} hitSlop={8} accessibilityLabel="Clear search" className="px-2">
              <Icon as={X} size={14} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => setSorting(true)}
          accessibilityRole="button"
          accessibilityLabel={`Sort: ${FORUM_SORT_LABELS[sort]}`}
          className="size-9 items-center justify-center rounded-md border border-input active:bg-accent"
        >
          <Icon as={ArrowUpDown} size={15} />
        </Pressable>
        {canManageTags ? (
          <Pressable
            onPress={() => router.push({ pathname: "/forum-tags", params: { room: roomId, channel: channelId ?? "" } })}
            accessibilityRole="button"
            accessibilityLabel="Set up this forum's tags"
            className="size-9 items-center justify-center rounded-md border border-input active:bg-accent"
          >
            <Icon as={Tags} size={15} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => router.push({ pathname: "/forum-new", params: { room: roomId, channel: channelId ?? "" } })}
          accessibilityRole="button"
          accessibilityLabel="New post"
          className="h-9 flex-row items-center gap-1.5 rounded-md bg-primary px-3 active:bg-primary/90"
        >
          <Icon as={Plus} size={16} tone="primary-foreground" />
          <T className="text-sm font-medium text-primary-foreground">New</T>
        </Pressable>
      </View>

      {tags.length > 0 ? (
        <View className="border-b border-border">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-1 px-3 py-2">
            <TagChip tag={{ tag_id: "", name: "All", color: "" }} selected={tagFilter === null} onPress={() => changeTag(null)} />
            {tags.map((t) => (
              <TagChip key={t.tag_id} tag={t} selected={tagFilter === t.tag_id} onPress={() => changeTag(tagFilter === t.tag_id ? null : t.tag_id)} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      <FlatList
        data={shown}
        keyExtractor={(p) => p.post_id}
        contentContainerClassName="gap-2 p-2"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.foreground} colors={[colors.primary]} />}
        onEndReached={() => {
          if (!hasMore || searching || loading) return;
          const cursor = forumPageCursor(posts, sort);
          if (cursor !== undefined) void load(sort, tagFilter, cursor);
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loading ? undefined : (
            <View className="items-center py-12">
              {searching ? (
                <T className="text-sm text-muted-foreground">No posts match your search</T>
              ) : (
                <>
                  <T className="text-sm text-muted-foreground">No posts yet</T>
                  <T className="mt-1 text-xs text-muted-foreground">Be the first to create a post!</T>
                </>
              )}
            </View>
          )
        }
        renderItem={({ item }) => (
          <PostCard post={item} tags={tags} onPress={() => openForumPost(roomId, item.post_id, channelId)} onLongPress={() => setActing(item)} />
        )}
      />

      <Sheet open={sorting} onClose={() => setSorting(false)} title="Sort posts">
        <View className="pb-2">
          {(Object.keys(FORUM_SORT_LABELS) as ForumSort[]).map((mode) => (
            <Pressable
              key={mode}
              onPress={() => changeSort(mode)}
              accessibilityRole="radio"
              accessibilityState={{ checked: sort === mode }}
              className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
            >
              <View className="w-4">{sort === mode ? <Icon as={Check} size={15} tone="foreground" /> : null}</View>
              <T className="text-sm">{FORUM_SORT_LABELS[mode]}</T>
            </Pressable>
          ))}
        </View>
      </Sheet>

      <PostActions
        post={acting}
        roomId={roomId}
        canPin={canPin}
        canDelete={!!acting && (acting.author === state.userId || canManagePosts)}
        onClose={() => setActing(null)}
      />
    </View>
  );
}

/** A post in the list (ForumPostCard): its lead picture, title, tags, who and
 *  when, two lines of it, its reactions and how many replies. */
function PostCard({ post, tags, onPress, onLongPress }: { post: ForumPost; tags: ForumTag[]; onPress(): void; onLongPress(): void }) {
  const state = useChatter();
  const pinned = !!post.pinned_at;
  const images = forumImages(post);
  const videos = forumVideos(post);
  const files = forumFiles(post);
  // One thing stands for the post: a picture, else a clip's poster.
  const thumbnail = images[0] ?? (videos[0] ? `${videos[0]}.thumb.jpg` : null);
  const extras = images.length + videos.length - 1;
  const author = state.userPresence[post.author]?.displayName || displayUserId(post.author);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`Open post: ${post.title}`}
      className={cn("flex-row gap-2.5 rounded-lg border p-2.5 active:bg-accent/50", pinned ? "border-primary/40 bg-primary/5" : "border-border")}
    >
      {thumbnail ? (
        <View>
          <Image source={serverImage(thumbnail)} style={{ width: 64, height: 64, borderRadius: 6 }} contentFit="cover" />
          {images.length === 0 && videos.length > 0 ? (
            <View className="absolute inset-0 items-center justify-center">
              <View className="size-7 items-center justify-center rounded-full bg-black/60">
                <Icon as={Play} size={14} color="#fff" />
              </View>
            </View>
          ) : null}
          {extras > 0 ? (
            <View className="absolute bottom-1 right-1 rounded bg-black/65 px-1.5 py-0.5">
              <T className="text-3xs font-medium text-white">+{extras}</T>
            </View>
          ) : null}
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-1.5">
          {pinned ? <Icon as={Pin} size={13} tone="primary" /> : null}
          <T className="flex-1 text-sm font-semibold leading-tight" numberOfLines={1}>
            {post.title}
          </T>
        </View>
        <TagList tagIds={post.tags} tags={tags} size="xs" />
        <T className="text-xs text-muted-foreground">
          {author} · {forumTime(post.created_at)}
          {post.edited ? " · (edited)" : ""}
        </T>
        {post.body ? (
          <T className={UI_HINT} numberOfLines={2}>
            {forumPlainText(post.body)}
          </T>
        ) : null}
        <View className="flex-row items-center gap-2 pt-1">
          <ForumReactions targetId={post.post_id} initial={post.reactions} compact />
          <View className="ml-auto flex-row items-center gap-2">
            {files.length > 0 ? (
              <View className="flex-row items-center gap-1">
                <Icon as={Paperclip} size={12} />
                <T className="text-3xs text-muted-foreground">{files.length}</T>
              </View>
            ) : null}
            <View className="flex-row items-center gap-1">
              <Icon as={MessageSquare} size={12} />
              <T className="text-3xs text-muted-foreground">{post.comment_count}</T>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/** Holding a post: its link, and for whoever may, pin and delete. */
function PostActions({
  post,
  roomId,
  canPin,
  canDelete,
  onClose,
}: {
  post: ForumPost | null;
  roomId: string;
  canPin: boolean;
  canDelete: boolean;
  onClose(): void;
}) {
  const fail = (what: string) => (e: unknown) => showToast({ tone: "error", message: e instanceof Error ? e.message : what });
  return (
    <Sheet open={!!post} onClose={onClose} title={post?.title}>
      {post ? (
        <View className="pb-1">
          <SheetRow
            icon={Link}
            label="Copy post link"
            onPress={() => {
              onClose();
              void Clipboard.setStringAsync(forumLinkFor(post.post_id));
              showToast({ message: "Post link copied" });
            }}
          />
          {canPin ? (
            <SheetRow
              icon={post.pinned_at ? PinOff : Pin}
              label={post.pinned_at ? "Unpin post" : "Pin post"}
              onPress={() => {
                onClose();
                // The broadcast moves it, here as for everyone.
                void (post.pinned_at ? apiUnpinForumPost(roomId, post.post_id) : apiPinForumPost(roomId, post.post_id)).catch(fail("Failed to update pin"));
              }}
            />
          ) : null}
          {canDelete ? (
            <SheetRow
              icon={Trash2}
              label="Delete post"
              destructive
              onPress={() => {
                onClose();
                Alert.alert("Delete this post?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => void apiDeleteForumPost(roomId, post.post_id).catch(fail("Failed to delete post")) },
                ]);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
