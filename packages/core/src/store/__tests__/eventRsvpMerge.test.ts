/**
 * Creating an event answers "going" for you. The room-wide broadcast of the
 * new event can reach the store before the request's own reply does, and the
 * broadcast never carries anyone's answer — the reply's must still win.
 */
import { describe, it, expect } from "vitest";
import { reducer } from "../reducer";
import { initialState, type AppState } from "../types";
import type { RoomEvent } from "../../api";

const base: RoomEvent = {
  event_id: "ev1",
  room_id: "!r:x",
  creator: "@me:x",
  name: "Board game night",
  description: "",
  location: "",
  channel_id: "",
  starts_at: 1_000,
  ends_at: 0,
  cover_url: "",
  created_at: 0,
  updated_at: 0,
  cancelled: false,
  going_count: 1,
  maybe_count: 0,
  going_preview: ["@me:x"],
  my_rsvp: "",
};

const start = { ...initialState, currentRoomId: "!r:x" } as AppState;
const upsert = (state: AppState, event: RoomEvent) => reducer(state, { type: "UPSERT_ROOM_EVENT", payload: event });

describe("UPSERT_ROOM_EVENT and your own answer", () => {
  it("keeps the creator's answer when the broadcast lands first", () => {
    const afterBroadcast = upsert(start, base);
    const afterReply = upsert(afterBroadcast, { ...base, my_rsvp: "going" });
    expect(afterReply.roomEvents[0].my_rsvp).toBe("going");
    expect(afterReply.roomEvents[0].going_count).toBe(1);
  });

  it("does not let a neighbour's broadcast blank out your answer", () => {
    const answered = upsert(start, { ...base, my_rsvp: "maybe" });
    const neighbour = upsert(answered, { ...base, going_count: 2 });
    expect(neighbour.roomEvents[0].my_rsvp).toBe("maybe");
    expect(neighbour.roomEvents[0].going_count).toBe(2);
  });
});
