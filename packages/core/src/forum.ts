import type { ForumComment, ForumPost } from "./api";

/**
 * A forum's list of posts and an open post, as the socket changes them.
 *
 * Pure functions over what a screen holds, so the web's ForumArea and
 * ForumPostView and the mobile forum screens apply a broadcast the same way.
 * Each takes the event's `type` and its payload (`detail`) as `host.emit`
 * delivers them.
 */

export type ForumSort = "activity" | "newest" | "oldest" | "popular";

export const FORUM_SORT_LABELS: Record<ForumSort, string> = {
  activity: "Active",
  newest: "Newest",
  oldest: "Oldest",
  popular: "Popular",
};

/** The socket events a forum screen listens for. */
export const FORUM_EVENTS = [
  "forum.post.created",
  "forum.post.deleted",
  "forum.post.edited",
  "forum.post.pinned",
  "forum.post.unpinned",
  "forum.comment.created",
  "forum.comment.deleted",
  "forum.comment.edited",
] as const;
export type ForumEvent = (typeof FORUM_EVENTS)[number];

/** What a forum event carries. Each event fills in its own part. */
export interface ForumEventDetail {
  room_id?: string;
  channel_id?: string | null;
  post_id?: string;
  comment_id?: string;
  post?: ForumPost;
  comment?: ForumComment;
  title?: string;
  body?: string;
  tags?: string[];
  edited?: boolean;
  edited_at?: number;
  pinned_by?: string;
  pinned_at?: number;
}

/**
 * Pinned posts first, newest pin first, then the rest in the list's sort —
 * the order the server pages in, kept when a pin, an unpin or a reply moves a
 * post without a reload. Only the activity sort re-sorts the rest: in the
 * others a post keeps the place the server gave it.
 */
export function orderForumPosts(posts: ForumPost[], sort: ForumSort): ForumPost[] {
  const pinned = posts.filter((p) => p.pinned_at).sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));
  const rest = posts.filter((p) => !p.pinned_at);
  if (sort === "activity") rest.sort((a, b) => b.last_activity - a.last_activity);
  return [...pinned, ...rest];
}

/**
 * Where the next page starts: the sort's own field on the last unpinned post.
 * Pinned posts are outside the paged feed, so they say nothing about it.
 * Undefined when there is nothing to page from.
 */
export function forumPageCursor(posts: ForumPost[], sort: ForumSort): number | undefined {
  const unpinned = posts.filter((p) => !p.pinned_at);
  const last = unpinned[unpinned.length - 1];
  if (!last) return undefined;
  if (sort === "newest" || sort === "oldest") return last.created_at;
  if (sort === "popular") return last.comment_count;
  return last.last_activity;
}

/** A further page, minus anything already listed (an unpinned post can come
 *  back in a later page). */
export function appendForumPage(posts: ForumPost[], page: ForumPost[]): ForumPost[] {
  const held = new Set(posts.map((p) => p.post_id));
  return [...posts, ...page.filter((p) => !held.has(p.post_id))];
}

/** The list a screen is showing: one forum (a channel, or a room that is a
 *  forum itself when `channelId` is null), sorted and maybe filtered. */
export interface ForumListView {
  roomId: string;
  channelId: string | null;
  sort: ForumSort;
  /** Only posts wearing this tag, or null for all. */
  tagFilter: string | null;
  /** Showing search results, which the socket does not keep up to date. */
  searching: boolean;
}

/** Whether an event is about the forum this view lists. Every forum channel
 *  in a room hears every broadcast. */
function inView(detail: ForumEventDetail, view: ForumListView): boolean {
  return detail.room_id === view.roomId && (detail.channel_id || null) === view.channelId;
}

/**
 * The list after one forum event. Returns the same array when nothing
 * changed. `now` stamps a reply's activity.
 */
export function applyForumListEvent(
  posts: ForumPost[],
  type: string,
  detail: ForumEventDetail,
  view: ForumListView,
  now = Date.now(),
): ForumPost[] {
  const sameRoom = detail.room_id === view.roomId;
  switch (type) {
    case "forum.post.created": {
      const post = detail.post;
      const passes = !view.tagFilter || (post?.tags ?? []).includes(view.tagFilter);
      if (!post || !inView(detail, view) || !passes || view.searching) return posts;
      if (posts.some((p) => p.post_id === post.post_id)) return posts;
      // Oldest first puts it at the end; otherwise below the pins, which stay
      // on top whatever arrives.
      if (view.sort === "oldest") return [...posts, post];
      const pins = posts.filter((p) => p.pinned_at);
      return [...pins, post, ...posts.filter((p) => !p.pinned_at)];
    }
    case "forum.post.deleted":
      if (!sameRoom) return posts;
      return posts.filter((p) => p.post_id !== detail.post_id);
    case "forum.post.edited":
      if (!sameRoom) return posts;
      return posts.map((p) => (p.post_id === detail.post_id ? editedPost(p, detail) : p));
    case "forum.post.pinned": {
      if (!inView(detail, view) || !posts.some((p) => p.post_id === detail.post_id)) return posts;
      const pin = { pinned_by: detail.pinned_by, pinned_at: detail.pinned_at };
      return orderForumPosts(
        posts.map((p) => (p.post_id === detail.post_id ? { ...p, ...pin } : p)),
        view.sort,
      );
    }
    case "forum.post.unpinned":
      if (!sameRoom) return posts;
      return orderForumPosts(
        posts.map((p) => (p.post_id === detail.post_id ? { ...p, pinned_by: undefined, pinned_at: undefined } : p)),
        view.sort,
      );
    case "forum.comment.created":
      if (!sameRoom || view.searching) return posts;
      return orderForumPosts(
        posts.map((p) =>
          p.post_id === detail.post_id ? { ...p, comment_count: p.comment_count + 1, last_activity: now } : p,
        ),
        view.sort,
      );
    case "forum.comment.deleted":
      if (!sameRoom) return posts;
      return posts.map((p) =>
        p.post_id === detail.post_id ? { ...p, comment_count: Math.max(0, p.comment_count - 1) } : p,
      );
    default:
      return posts;
  }
}

/**
 * A pin of a post further down than anything loaded: it still belongs at the
 * top, so the caller fetches it (`apiGetForumPost`) and adds it with
 * `addPinnedPost`. Returns the post id to fetch, or null.
 */
export function pinnedPostToFetch(posts: ForumPost[], type: string, detail: ForumEventDetail, view: ForumListView): string | null {
  if (type !== "forum.post.pinned" || view.searching || !detail.post_id || !inView(detail, view)) return null;
  return posts.some((p) => p.post_id === detail.post_id) ? null : detail.post_id;
}

/** The fetched post of a pin, placed at the top — unless the view's tag
 *  filter would not show it, or it arrived meanwhile. */
export function addPinnedPost(posts: ForumPost[], post: ForumPost, detail: ForumEventDetail, view: ForumListView): ForumPost[] {
  if (view.tagFilter && !(post.tags ?? []).includes(view.tagFilter)) return posts;
  if (posts.some((p) => p.post_id === post.post_id)) return posts;
  return orderForumPosts([{ ...post, pinned_by: detail.pinned_by, pinned_at: detail.pinned_at }, ...posts], view.sort);
}

function editedPost(post: ForumPost, detail: ForumEventDetail): ForumPost {
  return {
    ...post,
    title: detail.title ?? post.title,
    body: detail.body ?? post.body,
    tags: detail.tags ?? post.tags,
    // A curator's retag is not the author's edit, and says so.
    edited: detail.edited ?? true,
    edited_at: detail.edited_at ?? post.edited_at,
  };
}

/** An open post and its comments. */
export interface ForumThreadState {
  post: ForumPost | null;
  comments: ForumComment[];
}

/**
 * An open post after one forum event. `gone` is set when the post itself was
 * deleted, for the screen to close. Returns the same object when nothing
 * changed.
 */
export function applyForumThreadEvent(
  thread: ForumThreadState,
  type: string,
  detail: ForumEventDetail,
  postId: string,
): ForumThreadState & { gone?: boolean } {
  if (detail.post_id !== postId) return thread;
  const { post, comments } = thread;
  switch (type) {
    case "forum.comment.created": {
      const comment = detail.comment;
      if (!comment || comments.some((c) => c.comment_id === comment.comment_id)) return thread;
      return {
        post: post ? { ...post, comment_count: post.comment_count + 1 } : post,
        comments: [...comments, comment],
      };
    }
    case "forum.comment.deleted": {
      // The server's own rule, applied now rather than on the next load: a
      // comment with replies under it leaves a tombstone, so its replies keep
      // their place in the thread.
      const holdsReplies = comments.some((c) => c.parent_id === detail.comment_id);
      const next = holdsReplies
        ? comments.map((c) =>
            c.comment_id === detail.comment_id
              ? { ...c, deleted: true, author: "", body: "", image_url: "", image_urls: [], video_urls: [], file_urls: [] }
              : c,
          )
        : comments.filter((c) => c.comment_id !== detail.comment_id);
      return { post: post ? { ...post, comment_count: Math.max(0, post.comment_count - 1) } : post, comments: next };
    }
    case "forum.comment.edited":
      return {
        post,
        comments: comments.map((c) =>
          c.comment_id === detail.comment_id ? { ...c, body: detail.body ?? c.body, edited: true, edited_at: detail.edited_at } : c,
        ),
      };
    case "forum.post.edited":
      return { post: post ? editedPost(post, detail) : post, comments };
    case "forum.post.deleted":
      return { ...thread, gone: true };
    default:
      return thread;
  }
}
