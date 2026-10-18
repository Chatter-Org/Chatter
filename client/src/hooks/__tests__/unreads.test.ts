import { describe, it, expect } from "vitest";
import { bucketsFromServer, deriveRoomUnreads, oldestUnreadEventId, type UnreadBuckets } from "@/lib/unreads";
import { reducer } from "@/lib/store/reducer";
import { initialState, type AppState } from "@/lib/store/types";

const empty: UnreadBuckets = {
  channelUnreadCounts: {},
  channelMentions: {},
  channelRoomIds: {},
  roomLooseUnreads: {},
  roomLooseMentions: {},
};

describe("deriveRoomUnreads", () => {
  it("sums a room's channels and its loose bucket", () => {
    const out = deriveRoomUnreads({
      ...empty,
      channelUnreadCounts: { "#a": 2, "#b": 3, "#other": 9 },
      channelMentions: { "#b": 1 },
      channelRoomIds: { "#a": "!r", "#b": "!r", "#other": "!s" },
      roomLooseUnreads: { "!r": 1 },
    });
    expect(out.roomUnreadCounts).toEqual({ "!r": 6, "!s": 9 });
    expect(out.roomMentions).toEqual({ "!r": 1 });
  });

  it("never draws a ping on a room it calls read", () => {
    const out = deriveRoomUnreads({ ...empty, roomLooseMentions: { "!r": 2 } });
    expect(out.roomUnreadCounts["!r"]).toBe(2);
  });
});

describe("bucketsFromServer", () => {
  it("files channel-less rows as the room's own and skips the channel on screen", () => {
    const out = bucketsFromServer(
      [
        { room_id: "!dm", channel_id: "", count: 2, mentions: 2 },
        { room_id: "!r", channel_id: "#a", count: 4, mentions: 1, latest_ts: 10 },
        { room_id: "!r", channel_id: "#open", count: 3, mentions: 0 },
      ],
      { roomId: "!r", channelId: "#open" },
    );
    expect(out.roomLooseUnreads).toEqual({ "!dm": 2 });
    expect(out.roomLooseMentions).toEqual({ "!dm": 2 });
    expect(out.channelUnreadCounts).toEqual({ "#a": 4 });
    expect(out.channelRoomIds).toEqual({ "#a": "!r" });
  });
});

describe("reducer unread flow", () => {
  const withChannelPing = (): AppState => {
    let s: AppState = { ...initialState, currentRoomId: "!elsewhere" };
    s = reducer(s, { type: "INCREMENT_CHANNEL_UNREAD", payload: { roomId: "!r", channelId: "#a", ts: 1 } });
    s = reducer(s, { type: "SET_CHANNEL_MENTION", payload: { roomId: "!r", channelId: "#a", hasMention: true } });
    return s;
  };

  it("keeps a room's ping after opening it until the channel is read", () => {
    let s = withChannelPing();
    expect(s.roomMentions["!r"]).toBe(1);
    // Opening the room used to wipe this while #a still held the mention.
    s = reducer(s, { type: "SELECT_ROOM", payload: "!r" });
    expect(s.roomMentions["!r"]).toBe(1);
    s = reducer(s, { type: "CLEAR_CHANNEL_UNREAD", payload: "#a" });
    expect(s.roomMentions["!r"] || 0).toBe(0);
    expect(s.roomUnreadCounts["!r"] || 0).toBe(0);
  });

  it("opening a room dismisses only its loose pings", () => {
    let s = withChannelPing();
    s = reducer(s, { type: "SET_MENTION", payload: { roomId: "!r", hasMention: true } });
    expect(s.roomMentions["!r"]).toBe(2);
    s = reducer(s, { type: "SELECT_ROOM", payload: "!r" });
    expect(s.roomMentions["!r"]).toBe(1);
  });

  it("clears a non-timeline channel's highlight when it is opened", () => {
    let s: AppState = {
      ...initialState,
      currentRoomId: "!r",
      channels: [{ channel_id: "#show", channel_type: "showcase" } as AppState["channels"][number]],
    };
    s = reducer(s, { type: "INCREMENT_CHANNEL_UNREAD", payload: { roomId: "!r", channelId: "#show" } });
    expect(s.channelUnreadCounts["#show"]).toBe(1);
    s = reducer(s, { type: "SELECT_CHANNEL", payload: "#show" });
    expect(s.channelUnreadCounts["#show"]).toBe(0);
    expect(s.roomUnreadCounts["!r"] || 0).toBe(0);
  });
});

describe("oldestUnreadEventId", () => {
  const msg = (event_id: string, sender: string, extra: object = {}) => ({ event_id, sender, ...extra });

  it("steps over the reader's own messages, system lines and deletions", () => {
    const timeline = [
      msg("$1", "@bob"),
      msg("$2", "@bob"),
      msg("$3", "@me"),
      msg("$4", "@sys", { content: { msgtype: "m.system" } }),
      msg("$5", "@bob", { redacted: true }),
      msg("$6", "@bob"),
    ];
    // Two unread: $6 and $2. Stepping back two rows landed on $5.
    expect(oldestUnreadEventId(timeline, 2, "@me")).toBe("$2");
  });

  it("places nothing while the oldest unread is not loaded", () => {
    expect(oldestUnreadEventId([msg("$1", "@bob")], 3, "@me")).toBeNull();
    expect(oldestUnreadEventId([msg("$1", "@bob")], 0, "@me")).toBeNull();
  });
});

describe("APPLY_READ_MARKER", () => {
  const lit: AppState = {
    ...initialState,
    currentRoomId: "!elsewhere",
    currentChannelId: "#x",
    channelUnreadCounts: { "#a": 5, "#b": 2 },
    channelMentions: { "#a": 2, "#b": 1 },
    channelRoomIds: { "#a": "!r", "#b": "!r" },
    roomLooseUnreads: { "!dm": 3 },
    roomLooseMentions: { "!dm": 3 },
    threadMentions: { $t: 2, $u: 1 },
  };
  const apply = (state: AppState, payload: Parameters<typeof reducer>[1] & { type: "APPLY_READ_MARKER" }) =>
    reducer(state, payload);

  it("keeps what arrived after the point read, and touches no other bucket", () => {
    const next = apply(lit, {
      type: "APPLY_READ_MARKER",
      payload: { roomId: "!r", channelId: "#a", count: 1, mentions: 0, latestTs: 10 },
    });
    expect(next.channelUnreadCounts).toEqual({ "#a": 1, "#b": 2 });
    expect(next.channelMentions).toEqual({ "#a": 0, "#b": 1 });
    expect(next.roomUnreadCounts["!r"]).toBe(3);
    expect(next.roomMentions["!r"]).toBe(1);
  });

  it("clears a DM's loose bucket", () => {
    const next = apply(lit, {
      type: "APPLY_READ_MARKER",
      payload: { roomId: "!dm", channelId: "", count: 0, mentions: 0, latestTs: 0 },
    });
    expect(next.roomUnreadCounts["!dm"] ?? 0).toBe(0);
    expect(next.channelUnreadCounts).toEqual(lit.channelUnreadCounts);
  });

  it("clears one thread's mentions and leaves the others", () => {
    const next = apply(lit, {
      type: "APPLY_READ_MARKER",
      payload: { roomId: "!r", threadId: "$t", mentions: 0 },
    });
    expect(next.threadMentions).toEqual({ $t: 0, $u: 1 });
  });

  it("leaves the channel on screen alone", () => {
    const viewing = { ...lit, currentRoomId: "!r", currentChannelId: "#a" };
    const next = apply(viewing, {
      type: "APPLY_READ_MARKER",
      payload: { roomId: "!r", channelId: "#a", count: 4, mentions: 1, latestTs: 10 },
    });
    expect(next).toBe(viewing);
  });
});
