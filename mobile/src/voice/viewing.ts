import { useSyncExternalStore } from "react";
import { MediaStream, RTCPeerConnection } from "react-native-webrtc";
import { StreamViewer, type ViewedKind, type ViewerPeer, type ViewerStream } from "@chatter/core/voice/viewer";
import { StreamPublisher, type PublisherPeer } from "@chatter/core/voice/publisher";

/**
 * Watching screen shares and webcams on the phone: the shared StreamViewer
 * (packages/core/src/voice/viewer.ts), one per kind, on react-native-webrtc.
 * ChatterProvider makes them, feeds them the socket's frames, and tells them
 * who is wanted; a view asks for a person's stream with `useWatchedStream`.
 */

let version = 0;
const listeners = new Set<() => void>();
function changed() {
  version += 1;
  for (const l of listeners) l();
}

export function createViewers(deps: {
  send(frame: Record<string, unknown>): boolean;
  roomId(): string | null;
  userId(): string | null;
}): Record<ViewedKind, StreamViewer> {
  const make = (kind: ViewedKind) =>
    new StreamViewer({
      kind,
      // The DOM and react-native-webrtc spell the config types apart; the fields are the same.
      createPeer: (config) => new RTCPeerConnection(config as ConstructorParameters<typeof RTCPeerConnection>[0]) as unknown as ViewerPeer,
      newStream: (track) => new MediaStream(track ? [track as never] : undefined) as unknown as ViewerStream,
      send: deps.send,
      roomId: deps.roomId,
      userId: deps.userId,
      onChange: changed,
    });
  viewers = { screen: make("screen"), webcam: make("webcam") };
  return viewers;
}

let viewers: Record<ViewedKind, StreamViewer> | null = null;

/** This phone's own camera (or screen), shown to its owner as a preview. */
const local: { userId: string | null; streams: Partial<Record<ViewedKind, MediaStream>> } = { userId: null, streams: {} };

export function setLocalStream(kind: ViewedKind, userId: string | null, stream: MediaStream | null): void {
  local.userId = userId;
  if (stream) local.streams[kind] = stream;
  else delete local.streams[kind];
  changed();
}

export function localStream(kind: ViewedKind): MediaStream | null {
  return local.streams[kind] ?? null;
}

/** The camera's way to the call: the shared StreamPublisher on react-native-webrtc. */
export function createPublisher(
  kind: ViewedKind,
  deps: { send(frame: Record<string, unknown>): boolean; roomId(): string | null; channelId(): string | null; onGiveUp(message: string): void },
): StreamPublisher {
  return new StreamPublisher({
    kind,
    createPeer: (config) => new RTCPeerConnection(config as ConstructorParameters<typeof RTCPeerConnection>[0]) as unknown as PublisherPeer,
    ...deps,
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The stream being watched from this person, as the URL an RTCView takes;
 * null until it has arrived (or once it has gone).
 */
export function useWatchedStream(kind: ViewedKind, userId: string | null): string | null {
  useSyncExternalStore(subscribe, () => version);
  if (!userId) return null;
  // One's own camera is shown from the phone, not fetched back from the call.
  if (userId === local.userId && local.streams[kind]) return local.streams[kind]!.toURL();
  if (!viewers) return null;
  const stream = viewers[kind].stream(userId) as unknown as MediaStream | undefined;
  return stream?.toURL() ?? null;
}
