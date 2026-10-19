import { describe, expect, it } from "vitest";
import type { ForumComment, ForumPost } from "../api";
import {
  addPinnedPost,
  appendForumPage,
  applyForumListEvent,
  applyForumThreadEvent,
  forumMarkdownToChat,
  forumPageCursor,
  forumPlainText,
  orderForumPosts,
  pinnedPostToFetch,
  type ForumListView,
} from "../forum";

function post(id: string, over: Partial<ForumPost> = {}): ForumPost {
  return {
    post_id: id,
    room_id: "!r",
    author: "@a:x",
    title: id,
    body: "",
    image_url: "",
    created_at: 0,
    comment_count: 0,
    last_activity: 0,
    reactions: {},
    ...over,
  };
}

function comment(id: string, parent?: string): ForumComment {
  return { comment_id: id, post_id: "p1", room_id: "!r", author: "@a:x", body: id, image_url: "", created_at: 0, parent_id: parent };
}

const view: ForumListView = { roomId: "!r", channelId: "c1", sort: "activity", tagFilter: null, searching: false };

describe("orderForumPosts", () => {
  it("puts pins first, newest pin first, then the rest by activity", () => {
    const list = [post("a", { last_activity: 1 }), post("b", { pinned_at: 5 }), post("c", { last_activity: 9 }), post("d", { pinned_at: 7 })];
    expect(orderForumPosts(list, "activity").map((p) => p.post_id)).toEqual(["d", "b", "c", "a"]);
  });
  it("keeps the server's order outside the activity sort", () => {
    const list = [post("a", { last_activity: 1 }), post("c", { last_activity: 9 })];
    expect(orderForumPosts(list, "newest").map((p) => p.post_id)).toEqual(["a", "c"]);
  });
});

describe("paging", () => {
  it("pages from the last unpinned post's sort field", () => {
    const list = [post("pin", { pinned_at: 1, created_at: 1 }), post("a", { created_at: 50, comment_count: 3, last_activity: 70 })];
    expect(forumPageCursor(list, "newest")).toBe(50);
    expect(forumPageCursor(list, "popular")).toBe(3);
    expect(forumPageCursor(list, "activity")).toBe(70);
    expect(forumPageCursor([post("pin", { pinned_at: 1 })], "activity")).toBeUndefined();
  });
  it("drops what a later page repeats", () => {
    expect(appendForumPage([post("a")], [post("a"), post("b")]).map((p) => p.post_id)).toEqual(["a", "b"]);
  });
});

describe("applyForumListEvent", () => {
  it("lists a new post below the pins, only in its own channel", () => {
    const list = [post("pin", { pinned_at: 1 }), post("a")];
    const created = { room_id: "!r", channel_id: "c1", post: post("new") };
    expect(applyForumListEvent(list, "forum.post.created", created, view).map((p) => p.post_id)).toEqual(["pin", "new", "a"]);
    expect(applyForumListEvent(list, "forum.post.created", { ...created, channel_id: "c2" }, view)).toBe(list);
  });
  it("leaves a new post out of a filtered list it does not match, and out of search", () => {
    const created = { room_id: "!r", channel_id: "c1", post: post("new", { tags: ["t2"] }) };
    expect(applyForumListEvent([], "forum.post.created", created, { ...view, tagFilter: "t1" })).toEqual([]);
    expect(applyForumListEvent([], "forum.post.created", created, { ...view, searching: true })).toEqual([]);
  });
  it("moves a post with a new reply up the activity sort", () => {
    const list = [post("a", { last_activity: 9 }), post("b", { last_activity: 1 })];
    const next = applyForumListEvent(list, "forum.comment.created", { room_id: "!r", post_id: "b" }, view, 100);
    expect(next.map((p) => p.post_id)).toEqual(["b", "a"]);
    expect(next[0].comment_count).toBe(1);
  });
  it("pins a loaded post to the top, and asks for one not loaded", () => {
    const list = [post("a", { last_activity: 9 }), post("b", { last_activity: 1 })];
    const pin = { room_id: "!r", channel_id: "c1", post_id: "b", pinned_by: "@m:x", pinned_at: 3 };
    expect(applyForumListEvent(list, "forum.post.pinned", pin, view)[0].post_id).toBe("b");
    expect(pinnedPostToFetch(list, "forum.post.pinned", pin, view)).toBeNull();
    const far = { ...pin, post_id: "z" };
    expect(pinnedPostToFetch(list, "forum.post.pinned", far, view)).toBe("z");
    expect(addPinnedPost(list, post("z"), far, view)[0]).toMatchObject({ post_id: "z", pinned_at: 3 });
  });
});

describe("applyForumThreadEvent", () => {
  const thread = { post: post("p1", { comment_count: 2 }), comments: [comment("c1"), comment("c2", "c1")] };

  it("adds a reply once, counting it", () => {
    const detail = { post_id: "p1", comment: comment("c3") };
    const next = applyForumThreadEvent(thread, "forum.comment.created", detail, "p1");
    expect(next.comments).toHaveLength(3);
    expect(next.post?.comment_count).toBe(3);
    expect(applyForumThreadEvent(next, "forum.comment.created", detail, "p1")).toBe(next);
  });
  it("leaves a tombstone for a deleted comment that holds replies", () => {
    const next = applyForumThreadEvent(thread, "forum.comment.deleted", { post_id: "p1", comment_id: "c1" }, "p1");
    expect(next.comments.find((c) => c.comment_id === "c1")).toMatchObject({ deleted: true, body: "" });
    const leaf = applyForumThreadEvent(thread, "forum.comment.deleted", { post_id: "p1", comment_id: "c2" }, "p1");
    expect(leaf.comments.map((c) => c.comment_id)).toEqual(["c1"]);
  });
  it("closes when the post goes, and ignores other posts", () => {
    expect(applyForumThreadEvent(thread, "forum.post.deleted", { post_id: "p1" }, "p1").gone).toBe(true);
    expect(applyForumThreadEvent(thread, "forum.post.deleted", { post_id: "p9" }, "p1")).toBe(thread);
  });
});

describe("forumMarkdownToChat", () => {
  it("carries Markdown over to the chat format", () => {
    const md = "# Title\nSome *soft* and __loud__ text with `code`.\n- one\n- two\n> quoted\n[docs](https://x.test/a)";
    expect(forumMarkdownToChat(md)).toBe(
      "**Title**\nSome _soft_ and **loud** text with code.\n• one\n• two\n▎ quoted\ndocs (https://x.test/a)",
    );
  });
  it("leaves bold, snake_case and code blocks alone", () => {
    expect(forumMarkdownToChat("**bold** snake_case_name")).toBe("**bold** snake_case_name");
    expect(forumMarkdownToChat("```\n*not italic*\n```")).toBe("```\n*not italic*\n```");
  });
  it("reads as plain words for an excerpt", () => {
    expect(forumPlainText("I can see **General**\n\nIs there a *join* button?")).toBe("I can see General Is there a join button?");
  });
});
