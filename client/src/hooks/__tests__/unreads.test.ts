import { describe, it, expect } from "vitest";
import { bucketsFromServer, deriveRoomUnreads, type UnreadBuckets } from "@/lib/unreads";
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
