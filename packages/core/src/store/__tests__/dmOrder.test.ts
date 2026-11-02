/**
 * The DM list is ordered by last activity: the newest message in the sync's
 * timeline to start with, then each live message as it arrives.
 */
import { describe, it, expect } from "vitest";
import { reducer } from "../../store/reducer";
import { initialState } from "../../store/types";
import type { AppState } from "../../store/types";
import { roomInfoFromSync } from "../actions";
import { sortDmsByActivity } from "../../sidebarOrder";

const withDm = (roomId: string, ts: number): AppState => ({
  ...initialState,
  roomInfoMap: { [roomId]: { room_id: roomId, name: "DM", topic: "", is_direct: true, last_activity_ts: ts } },
});

describe("DM order", () => {
  it("reads last activity off the sync timeline", () => {
    const info = roomInfoFromSync("!dm:x", {
      state: { events: [] },
      timeline: { events: [{ origin_server_ts: 5 }, { origin_server_ts: 9 }] },
    });
    expect(info.last_activity_ts).toBe(9);
  });

  it("moves last activity forward, never back", () => {
    const later = reducer(withDm("!dm:x", 10), { type: "NOTE_ROOM_ACTIVITY", payload: { roomId: "!dm:x", ts: 20 } });
    expect(later.roomInfoMap["!dm:x"].last_activity_ts).toBe(20);
    const stale = reducer(later, { type: "NOTE_ROOM_ACTIVITY", payload: { roomId: "!dm:x", ts: 15 } });
    expect(stale).toBe(later);
  });

  it("sorts newest first, keeping unknowns in their order at the end", () => {
    const ts: Record<string, number | undefined> = { a: 1, b: undefined, c: 3, d: undefined, e: 2 };
    expect(sortDmsByActivity(["a", "b", "c", "d", "e"], (id) => ts[id])).toEqual(["c", "e", "a", "b", "d"]);
  });
});
