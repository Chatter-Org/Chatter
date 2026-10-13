import { describe, expect, it } from "vitest";
import { peekableSharers } from "@/lib/screenThumbnail";
import type { VoiceChannelMember } from "@/lib/store/types";

const member = (userId: string, screen_sharing: boolean) =>
  ({ userId, muted: false, deafened: false, screen_sharing }) as VoiceChannelMember;

const base = {
  currentRoomId: "room-a",
  voiceChannelRooms: { "vc-1": "room-a", "vc-2": "room-a", "vc-other": "room-b" },
  voiceChannelMembers: {
    "vc-1": [member("alice", true), member("bob", false)],
    "vc-2": [member("carol", true)],
    "vc-other": [member("dave", true)],
  },
  inVoiceChannel: false,
  voiceChannelId: null,
};

describe("peekableSharers", () => {
  it("offers every sharer in the room on screen to someone in no call", () => {
    expect([...peekableSharers(base)].sort()).toEqual(["alice", "carol"]);
  });

  it("leaves out sharers in the viewer's own channel, who have the live stream", () => {
    const sharers = peekableSharers({ ...base, inVoiceChannel: true, voiceChannelId: "vc-1" });
    expect([...sharers]).toEqual(["carol"]);
  });

  it("still offers a sharer to someone in a call in another room", () => {
    const sharers = peekableSharers({ ...base, inVoiceChannel: true, voiceChannelId: "vc-other" });
    expect([...sharers].sort()).toEqual(["alice", "carol"]);
  });
});
