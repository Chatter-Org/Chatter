/**
 * Watching screen shares and webcams (StreamViewer), against fake peers: it
 * subscribes only to who is wanted, signals with the kind's own messages,
 * gathers a sharer's tracks into one stream, lets go when told, starts again
 * when a sharer does, and retries a connection that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamViewer, type ViewerPeer, type ViewerStream, type ViewedKind } from "../viewer";

class FakeStream implements ViewerStream {
  tracks: { id: string }[] = [];
  constructor(track?: { id: string } | null) {
    if (track) this.tracks.push(track);
  }
  addTrack(track: unknown) {
    this.tracks.push(track as { id: string });
  }
  getTrackById(id: string) {
    return this.tracks.find((t) => t.id === id);
  }
}

class FakePeer implements ViewerPeer {
  connectionState = "new";
  onicecandidate: ViewerPeer["onicecandidate"] = null;
  ontrack: ViewerPeer["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  transceivers: string[] = [];
  remote: string | null = null;
  closed = false;
  addTransceiver(kind: "audio" | "video") {
    this.transceivers.push(kind);
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(desc: { sdp: string }) {
    this.remote = desc.sdp;
  }
  async addIceCandidate() {}
  close() {
    this.closed = true;
  }
}

function setup(kind: ViewedKind = "screen") {
  const peers: FakePeer[] = [];
  const sent: Record<string, unknown>[] = [];
  const onChange = vi.fn();
  const viewer = new StreamViewer({
    kind,
    createPeer: () => {
      const p = new FakePeer();
      peers.push(p);
      return p;
    },
    newStream: (track) => new FakeStream(track as { id: string }),
    send: (frame) => (sent.push(frame), true),
    roomId: () => "!room",
    userId: () => "@me",
    onChange,
  });
  return { viewer, peers, sent, onChange };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("StreamViewer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("watches nobody until someone is wanted, and never itself", async () => {
    const { viewer, peers } = setup();
    viewer.setWanted([]);
    viewer.setWanted(["@me"]);
    expect(peers).toHaveLength(0);
  });

  it("offers for a screen's video and sound, a webcam's video only", async () => {
    const screen = setup("screen");
    screen.viewer.setWanted(["@ann"]);
    await flush();
    expect(screen.peers[0].transceivers).toEqual(["video", "audio"]);
    expect(screen.sent[0]).toMatchObject({ type: "screen_webrtc_subscribe_offer", room_id: "!room", sharer_user_id: "@ann", sdp: "offer-sdp" });

    const webcam = setup("webcam");
    webcam.viewer.setWanted(["@ann"]);
    await flush();
    expect(webcam.peers[0].transceivers).toEqual(["video"]);
    expect(webcam.sent[0]).toMatchObject({ type: "webcam_webrtc_subscribe_offer" });
  });

  it("applies the answer and gathers tracks into one stream", async () => {
    const { viewer, peers, onChange } = setup();
    viewer.setWanted(["@ann"]);
    await flush();
    await viewer.handleFrame({ type: "screen_webrtc_subscribe_answer", sharer_user_id: "@ann", sdp: "answer-sdp" });
    expect(peers[0].remote).toBe("answer-sdp");
    // Another kind's answer is not this viewer's business.
    await viewer.handleFrame({ type: "webcam_webrtc_subscribe_answer", sharer_user_id: "@ann", sdp: "other" });
    expect(peers[0].remote).toBe("answer-sdp");

    const stream = new FakeStream({ id: "v" });
    peers[0].ontrack!({ track: { id: "v" }, streams: [stream] });
    peers[0].ontrack!({ track: { id: "a" }, streams: [] });
    expect(viewer.stream("@ann")).toBe(stream);
    expect(stream.tracks.map((t) => t.id)).toEqual(["v", "a"]);
    expect(onChange).toHaveBeenCalled();
  });

  it("lets go of everyone when the viewer closes", async () => {
    const { viewer, peers } = setup();
    viewer.setWanted(["@ann", "@bob"]);
    await flush();
    peers[0].ontrack!({ track: { id: "v" }, streams: [new FakeStream()] });
    viewer.setWanted([]);
    expect(peers.every((p) => p.closed)).toBe(true);
    expect(viewer.stream("@ann")).toBeUndefined();
  });

  it("starts again when a wanted sharer's publisher is ready, not otherwise", async () => {
    const { viewer, peers } = setup();
    viewer.setWanted(["@ann"]);
    await flush();
    await viewer.handleFrame({ type: "screen_webrtc_publisher_ready", user_id: "@ann" });
    await flush();
    expect(peers).toHaveLength(2);
    expect(peers[0].closed).toBe(true);
    await viewer.handleFrame({ type: "screen_webrtc_publisher_ready", user_id: "@zed" });
    expect(peers).toHaveLength(2);
  });

  it("retries a connection that fails", async () => {
    const { viewer, peers } = setup();
    viewer.setWanted(["@ann"]);
    await flush();
    peers[0].connectionState = "failed";
    peers[0].onconnectionstatechange!();
    expect(peers[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(peers).toHaveLength(2);
  });

  it("does not retry for someone no longer wanted", async () => {
    const { viewer, peers } = setup();
    viewer.setWanted(["@ann"]);
    await flush();
    await viewer.handleFrame({ type: "screen_webrtc_error", scope: "subscribe", sharer_user_id: "@ann" });
    viewer.setWanted([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(peers).toHaveLength(1);
  });
});
