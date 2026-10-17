import { describe, it, expect } from "vitest";
import { reducer } from "@/lib/store/reducer";
import { initialState } from "@/lib/store/types";
import type { AppState } from "@/lib/store/types";
import type { MatrixMessage } from "@/lib/api";

const message = (eventId: string): MatrixMessage => ({
  event_id: eventId,
  sender: "@someone:localhost",
  room_id: "!room:localhost",
  origin_server_ts: 1,
  type: "m.room.message",
  content: { body: "hello", msgtype: "m.text" },
});

const inAThread = (): AppState => ({
  ...initialState,
  currentRoomId: "!room:localhost",
  currentChannelId: "!general:localhost",
  activeThreadEventId: "$root",
  threadRootMessage: message("$root"),
  threadMessages: [message("$reply")],
});

describe("leaving a thread", () => {
  it("closes when another channel is picked", () => {
    // The thread panel renders on activeThreadEventId alone, so leaving it set
    // made clicking a channel look like it did nothing.
    const next = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!other:localhost",
    });

    expect(next.currentChannelId).toBe("!other:localhost");
    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("closes when another room is picked", () => {
    const next = reducer(inAThread(), {
      type: "SELECT_ROOM",
      payload: "!elsewhere:localhost",
    });

    expect(next.activeThreadEventId).toBeNull();
    expect(next.threadRootMessage).toBeNull();
    expect(next.threadMessages).toEqual([]);
  });

  it("still closes when the channel picked is the one already open", () => {
    // Re-selecting the current channel is how the UI gets back to its message
    // list, so it has to leave the thread too.
    const next = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!general:localhost",
    });

    expect(next.activeThreadEventId).toBeNull();
  });

  it("opens a thread that arrives after the channel change", () => {
    // The sidebar selects a thread's channel and opens the thread without
    // waiting, so the open must survive the select that precedes it.
    const selected = reducer(inAThread(), {
      type: "SELECT_CHANNEL",
      payload: "!other:localhost",
    });
    const opened = reducer(selected, {
      type: "OPEN_THREAD",
      payload: {
        eventId: "$newroot",
        root: message("$newroot"),
        messages: [message("$newreply")],
        hasMore: false,
        posters: [],
      },
    });

    expect(opened.activeThreadEventId).toBe("$newroot");
    expect(opened.threadMessages).toHaveLength(1);
  });
});

describe("replying inside a thread", () => {
  it("aims the thread's composer, not the channel's", () => {
    const next = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });

    expect(next.threadReplyingTo?.event_id).toBe("$reply");
    expect(next.replyingTo).toBeNull();
  });

  it("forgets the target when the thread closes", () => {
    const replying = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });
    const closed = reducer(replying, { type: "CLOSE_THREAD" });

    expect(closed.threadReplyingTo).toBeNull();
  });

  it("drops the target when the message it answers is deleted", () => {
    const replying = reducer(inAThread(), {
      type: "SET_THREAD_REPLYING_TO",
      payload: message("$reply"),
    });
    const next = reducer(replying, { type: "REDACT_MESSAGE", payload: "$reply" });

    expect(next.threadReplyingTo).toBeNull();
  });
});

describe("a thread's pins", () => {
  const pin = (eventId: string, threadId = "$root") => ({
    ...message(eventId),
    thread_id: threadId,
    pinned_by: "@mod:localhost",
    pinned_at: 2,
  });

  it("lands in the thread, never in the channel's list", () => {
    const next = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });

    expect(next.threadPins.map((m) => m.event_id)).toEqual(["$reply"]);
    expect(next.pinnedMessages).toEqual([]);
  });

  it("ignores a pin from a thread that is not open", () => {
    const next = reducer(inAThread(), {
      type: "ADD_THREAD_PIN",
      payload: pin("$elsewhere", "$otherroot"),
    });

    expect(next.threadPins).toEqual([]);
  });

  it("ignores a late answer for a thread that was swapped out", () => {
    const next = reducer(inAThread(), {
      type: "SET_THREAD_PINS",
      payload: { threadId: "$otherroot", pins: [pin("$x", "$otherroot")] },
    });

    expect(next.threadPins).toEqual([]);
  });

  it("is unpinned by the same event as a channel pin", () => {
    const pinned = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });
    const next = reducer(pinned, { type: "REMOVE_PINNED_MESSAGE", payload: "$reply" });

    expect(next.threadPins).toEqual([]);
  });

  it("starts empty for each thread opened", () => {
    const pinned = reducer(inAThread(), { type: "ADD_THREAD_PIN", payload: pin("$reply") });
    const next = reducer(pinned, {
      type: "OPEN_THREAD",
      payload: { eventId: "$newroot", root: message("$newroot"), messages: [], hasMore: false, posters: [] },
    });

    expect(next.threadPins).toEqual([]);
  });
});

describe("paging a thread", () => {
  it("prepends an older page above what is held, once", () => {
    const state = { ...inAThread(), threadHasMore: true, threadLoadingOlder: true };
    const next = reducer(state, {
      type: "PREPEND_THREAD_MESSAGES",
      // "$reply" is already held: a page that overlaps must not draw it twice.
      payload: { threadId: "$root", messages: [message("$older"), message("$reply")], hasMore: false },
    });

    expect(next.threadMessages.map((m) => m.event_id)).toEqual(["$older", "$reply"]);
    expect(next.threadHasMore).toBe(false);
    expect(next.threadLoadingOlder).toBe(false);
  });

  it("drops a page that arrives for a thread no longer open", () => {
    const next = reducer(inAThread(), {
      type: "PREPEND_THREAD_MESSAGES",
      payload: { threadId: "$elsewhere", messages: [message("$older")], hasMore: false },
    });

    expect(next.threadMessages.map((m) => m.event_id)).toEqual(["$reply"]);
  });

  it("counts replies off the root, which a live count reaches", () => {
    // The panel holds only the pages loaded, so its header reads the count
    // the server keeps rather than the length of what it holds.
    const next = reducer(inAThread(), {
      type: "UPDATE_THREAD_REPLY_COUNT",
      payload: { eventId: "$root", count: 240 },
    });

    expect(next.threadRootMessage?.thread_reply_count).toBe(240);
  });

  it("adds a new poster as their reply arrives", () => {
    const state = { ...inAThread(), threadPosters: ["@someone:localhost"] };
    const reply = { ...message("$new"), sender: "@newcomer:localhost", thread_id: "$root" };
    const next = reducer(state, { type: "ADD_THREAD_MESSAGE", payload: reply });

    expect(next.threadPosters).toEqual(["@someone:localhost", "@newcomer:localhost"]);
  });
});
