import { describe, it, expect, beforeEach } from "vitest";
import { loadLastChannels, pickLandingChannel, saveLastChannels } from "@/lib/lastChannel";

/** Enough of `localStorage` for the module to talk to. */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
}

describe("last channel per room", () => {
  beforeEach(installStorage);

  it("survives a reload, per account, merging rather than replacing", () => {
    saveLastChannels("@a:h", { "!r1": "#one" });
    saveLastChannels("@a:h", { "!r2": "#two" });
    expect(loadLastChannels("@a:h")).toEqual({ "!r1": "#one", "!r2": "#two" });
    expect(loadLastChannels("@b:h")).toEqual({});
    expect(loadLastChannels(null)).toEqual({});
  });

  it("shrugs off a corrupt entry", () => {
    localStorage.setItem("chatter_last_channel:@a:h", "not json");
    expect(loadLastChannels("@a:h")).toEqual({});
  });

  const channels = [
    { channel_id: "#voice", channel_type: "voice" },
    { channel_id: "#general", channel_type: "text" },
    { channel_id: "#forum", channel_type: "forum" },
  ];

  it("lands on the remembered channel, whatever kind it is", () => {
    expect(pickLandingChannel(channels, "#forum")?.channel_id).toBe("#forum");
  });

  it("never rejoins a call, and falls back when the channel is gone", () => {
    expect(pickLandingChannel(channels, "#voice")?.channel_id).toBe("#general");
    expect(pickLandingChannel(channels, "#deleted")?.channel_id).toBe("#general");
    expect(pickLandingChannel(channels, undefined)?.channel_id).toBe("#general");
  });
});
