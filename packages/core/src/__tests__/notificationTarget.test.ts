/**
 * A notification's destination as query parameters, the form a push reopens
 * the web app with and the phone's `chatter://open?…` links take.
 *
 * Room ids carry `!` and `:`, and thread and post ids are prefixed base64url,
 * so the round trip has to survive encoding; and a query without a room is no
 * destination at all, so it must come back as nothing rather than a half one.
 */
import { describe, it, expect } from "vitest";
import { notificationTargetFromQuery, notificationTargetQuery } from "../notifications";

describe("notification target query", () => {
  it("round-trips every part", () => {
    const target = {
      roomId: "!abc:chatter.example",
      channelId: "ch_1",
      threadId: "$ev+/=1",
      postId: "post_a-b_c",
      panel: "events" as const,
    };
    expect(notificationTargetFromQuery(new URLSearchParams(notificationTargetQuery(target)))).toEqual(target);
  });

  it("leaves out what is not there", () => {
    const query = notificationTargetQuery({ roomId: "!r:x" });
    expect(query).toBe("room=%21r%3Ax");
    expect(notificationTargetFromQuery(new URLSearchParams(query))).toEqual({
      roomId: "!r:x",
      channelId: undefined,
      threadId: undefined,
      postId: undefined,
      panel: undefined,
    });
  });

  it("is nothing without a room", () => {
    expect(notificationTargetFromQuery(new URLSearchParams("channel=c&thread=t"))).toBeNull();
  });

  it("ignores a panel it does not know", () => {
    expect(notificationTargetFromQuery(new URLSearchParams("room=r&panel=settings"))?.panel).toBeUndefined();
  });
});
