import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreActions, roomInfoFromSync } from "../actions";
import { initialState, type Action, type AppState } from "../types";

function harness(state: Partial<AppState> = {}) {
  let current: AppState = { ...initialState, ...state } as AppState;
  const dispatched: Action[] = [];
  const sent: Record<string, unknown>[] = [];
  let socketOpen = true;
  const actions = createStoreActions({
    dispatch: (a) => {
      dispatched.push(a);
      if (a.type === "SET_REACTIONS") {
        current = {
          ...current,
          messageReactions: { ...current.messageReactions, [a.payload.eventId]: a.payload.reactions },
        };
      }
    },
    getState: () => current,
    send: (frame) => {
      if (!socketOpen) return false;
      sent.push(frame);
      return true;
    },
  });
  return { actions, dispatched, sent, closeSocket: () => (socketOpen = false) };
}

describe("roomInfoFromSync", () => {
  it("reads a room's facts out of its state events", () => {
    const info = roomInfoFromSync("!r:x", {
      state: {
        events: [
          { type: "m.room.name", sender: "@owner:x", content: { name: "Games" } },
          { type: "m.room.topic", content: { topic: "anything goes" } },
          { type: "m.room.type", content: { room_type: "forum" } },
        ],
      },
    });
    expect(info).toMatchObject({ room_id: "!r:x", name: "Games", topic: "anything goes", creator: "@owner:x", room_type: "forum" });
  });

  it("falls back to the membership for a DM's people when the server does not list them", () => {
    const info = roomInfoFromSync("!dm:x", {
      state: {
        events: [
          { type: "m.room.direct", content: { is_direct: true } },
          { type: "m.room.member", state_key: "@a:x" },
          { type: "m.room.member", state_key: "@b:x" },
        ],
      },
    });
    expect(info.is_direct).toBe(true);
    expect(info.dm_user_ids).toEqual(["@a:x", "@b:x"]);
  });

  it("keeps entrance sounds on for a room that never said otherwise", () => {
    expect(roomInfoFromSync("!r:x", { state: { events: [] } }).entrance_sounds_enabled).toBe(true);
  });

  it("names a room it has no state for", () => {
    expect(roomInfoFromSync("!r:x", undefined)).toEqual({ room_id: "!r:x", name: "Unnamed Room", topic: "" });
  });
});

describe("addReaction", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("adds the reaction before the server answers", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { actions, dispatched } = harness({ currentRoomId: "!r:x", userId: "@me:x" });
    await actions.addReaction("$e", "👍");
    expect(dispatched[0]).toEqual({ type: "SET_REACTIONS", payload: { eventId: "$e", reactions: { "👍": ["@me:x"] } } });
  });

  it("takes your own reaction back off, dropping an emoji nobody is left on", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const { actions, dispatched } = harness({
      currentRoomId: "!r:x",
      userId: "@me:x",
      messageReactions: { $e: { "👍": ["@me:x"], "🎉": ["@you:x"] } },
    });
    await actions.addReaction("$e", "👍");
    expect(dispatched[0]).toEqual({ type: "SET_REACTIONS", payload: { eventId: "$e", reactions: { "🎉": ["@you:x"] } } });
  });

  it("puts things back when the server refuses", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { actions, dispatched } = harness({ currentRoomId: "!r:x", userId: "@me:x" });
    await actions.addReaction("$e", "👍");
    await vi.waitFor(() => expect(dispatched).toHaveLength(2));
    expect(dispatched[1]).toEqual({ type: "SET_REACTIONS", payload: { eventId: "$e", reactions: {} } });
  });
});

describe("sendTyping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tells the room once a second at most", () => {
    const { actions, sent } = harness({ currentRoomId: "!r:x", currentChannelId: "#c" });
    actions.sendTyping();
    actions.sendTyping();
    expect(sent).toEqual([{ type: "typing", room_id: "!r:x", channel_id: "#c" }]);
    vi.advanceTimersByTime(1000);
    actions.sendTyping();
    expect(sent).toHaveLength(2);
  });

  it("says nothing outside a room", () => {
    const { actions, sent } = harness();
    actions.sendTyping();
    expect(sent).toEqual([]);
  });
});

describe("requestVoiceSync", () => {
  it("answers whether there was a socket to ask on", () => {
    const { actions, sent, closeSocket } = harness();
    expect(actions.requestVoiceSync()).toBe(true);
    expect(sent).toEqual([{ type: "voice_state_request" }]);
    closeSocket();
    expect(actions.requestVoiceSync()).toBe(false);
  });
});
