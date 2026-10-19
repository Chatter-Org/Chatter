/**
 * Sending a camera or screen (StreamPublisher), against a fake peer: the
 * offer goes with the room and channel, our candidates wait for it, the
 * answer is applied and the sender tuned again, and a connection that fails
 * or never connects gives up and says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamPublisher, type PublisherPeer, type PublisherSender } from "../publisher";

class FakeSender implements PublisherSender {
  params: { encodings?: Record<string, unknown>[]; degradationPreference?: string } = { encodings: [{}] };
  sets = 0;
  getParameters() {
    return structuredClone(this.params);
  }
  async setParameters(p: unknown) {
    this.params = p as FakeSender["params"];
    this.sets += 1;
  }
}

class FakePeer implements PublisherPeer {
  connectionState = "new";
  onicecandidate: PublisherPeer["onicecandidate"] = null;
  onconnectionstatechange: (() => void) | null = null;
  sender = new FakeSender();
  remote: string | null = null;
  added: unknown[] = [];
  closed = false;
  addTrack() {
    return this.sender;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
  }
  async addIceCandidate(c: unknown) {
    this.added.push(c);
  }
  framesSent: number | null = null;
  async getStats() {
    const reports = this.framesSent === null ? [] : [{ type: "outbound-rtp", kind: "video", framesSent: this.framesSent }];
    return { forEach: (cb: (r: Record<string, unknown>) => void) => reports.forEach(cb) };
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const peer = new FakePeer();
  const sent: Record<string, unknown>[] = [];
  const onGiveUp = vi.fn();
  const pub = new StreamPublisher({
    kind: "webcam",
    createPeer: () => peer,
    send: (f) => (sent.push(f), true),
    roomId: () => "!room",
    channelId: () => "ch",
    onGiveUp,
  });
  return { pub, peer, sent, onGiveUp };
}

const tuning = { maxBitrateBps: 2_500_000, maxFramerate: 30, degradationPreference: "maintain-framerate" as const };

describe("StreamPublisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers with the room and channel, and holds candidates until then", async () => {
    const { pub, peer, sent } = setup();
    const starting = pub.start("track", "stream", tuning);
    peer.onicecandidate!({ candidate: { toJSON: () => "c1" } });
    expect(sent).toHaveLength(0);
    await starting;
    expect(sent[0]).toMatchObject({ type: "webcam_webrtc_publish_offer", room_id: "!room", channel_id: "ch", sdp: "offer-sdp" });
    expect(sent[1]).toMatchObject({ type: "webcam_webrtc_publish_candidate", candidate: "c1" });
    expect(peer.sender.params.encodings?.[0]).toMatchObject({ maxBitrate: 2_500_000, maxFramerate: 30 });
  });

  it("applies the answer, adds the server's candidates after it, and tunes again", async () => {
    const { pub, peer } = setup();
    await pub.start("track", "stream", tuning);
    await pub.handleFrame({ type: "webcam_webrtc_publish_candidate", candidate: "s1" });
    expect(peer.added).toEqual([]);
    const sets = peer.sender.sets;
    await pub.handleFrame({ type: "webcam_webrtc_publish_answer", sdp: "answer-sdp" });
    expect(peer.remote).toBe("answer-sdp");
    expect(peer.added).toEqual(["s1"]);
    expect(peer.sender.sets).toBeGreaterThan(sets);
  });

  it("gives up when the connection fails", async () => {
    const { pub, peer, onGiveUp } = setup();
    await pub.start("track", "stream", tuning);
    peer.connectionState = "failed";
    peer.onconnectionstatechange!();
    expect(peer.closed).toBe(true);
    expect(onGiveUp).toHaveBeenCalledWith(expect.stringContaining("camera lost its connection"));
    expect(pub.active).toBe(false);
  });

  it("gives up when it never connects", async () => {
    const { pub, onGiveUp } = setup();
    await pub.start("track", "stream", tuning);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(onGiveUp).toHaveBeenCalledWith(expect.stringContaining("couldn't connect"));
  });

  it("ignores the other kind's frames, and stops quietly", async () => {
    const { pub, peer, onGiveUp } = setup();
    await pub.start("track", "stream", tuning);
    await pub.handleFrame({ type: "screen_webrtc_publish_answer", sdp: "x" });
    expect(peer.remote).toBeNull();
    pub.stop();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up when connected but sending no pictures", async () => {
    const { pub, peer, onGiveUp } = setup();
    await pub.start("track", "stream", tuning);
    peer.framesSent = 0;
    peer.connectionState = "connected";
    peer.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onGiveUp).toHaveBeenCalledWith(expect.stringContaining("isn't sending anything"));
  });

  it("keeps a connection that is sending", async () => {
    const { pub, peer, onGiveUp } = setup();
    await pub.start("track", "stream", tuning);
    peer.framesSent = 120;
    peer.connectionState = "connected";
    peer.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(pub.active).toBe(true);
  });
});
