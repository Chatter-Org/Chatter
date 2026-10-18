import { screenThumbnailsMap } from "@/lib/store";
import type { AppState } from "@/lib/store/types";

/** One downscaled JPEG of a live screen share, as a `data:` URL.
 *
 *  The only place a frame of a share can be grabbed cheaply is the sharer's
 *  own tab: it holds the raw capture, while the server forwards the share as
 *  opaque RTP packets it never decodes and a viewer outside the call has no
 *  stream at all. So the sharer snapshots its own capture on a slow timer and
 *  posts it; everyone else reads it back. See `routes/screenshare.rs`.
 *
 *  A single hidden `<video>` element is reused across captures: a MediaStream
 *  only advances frames while it is attached to a playing element, and
 *  building a fresh one per snapshot would leak an element per tick. */
let captureElement: HTMLVideoElement | null = null;

/** Longest edge of the still. It is a hover peek, not the stream itself, so a
 *  couple hundred pixels is plenty and keeps the posted JPEG in the tens of
 *  kilobytes the server allows. */
const MAX_EDGE = 256;

/** JPEG quality. Low on purpose: it is a thumbnail shown at a few centimetres,
 *  and every byte is re-posted on the capture timer. */
const JPEG_QUALITY = 0.6;

/** Draw the current frame of `stream` to a small canvas and return it as a
 *  JPEG data URL, or `null` when there is no video track or no frame has
 *  decoded yet (a share that has just started). */
export function captureScreenThumbnail(stream: MediaStream): string | null {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return null;

  if (!captureElement) {
    // No `autoplay`: Chrome pauses a muted *autoplaying* video that is not
    // visible, and this one is never in the document. An explicit play() is
    // not subject to that.
    const element = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    element.disablePictureInPicture = true;
    captureElement = element;
  }

  // Only on a new stream. Assigning `srcObject` — even the same one — reruns
  // the element's load algorithm, which drops it back to no frame at all, so
  // reassigning per tick read `videoWidth` as 0 every time and no still was
  // ever posted. The first tick after attaching usually has no frame yet; the
  // next one does.
  if (captureElement.srcObject !== stream) {
    captureElement.srcObject = stream;
  }
  if (captureElement.paused) {
    try {
      captureElement.play().catch(() => {});
    } catch {
      // A live MediaStream is already advancing; play() is only to be sure.
    }
  }

  const naturalWidth = captureElement.videoWidth;
  const naturalHeight = captureElement.videoHeight;
  if (!naturalWidth || !naturalHeight) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(captureElement, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Let go of the capture when the share ends, so the hidden element does not
 *  keep the finished stream's tracks referenced until the next share. */
export function releaseScreenThumbnailCapture() {
  if (!captureElement) return;
  captureElement.pause();
  captureElement.srcObject = null;
}

/** Everything drawing a still re-reads it when the set changes. The map is a
 *  module map, not reducer state, so without this a row would only ever show
 *  the still it happened to read when something else re-rendered it. */
const listeners = new Set<() => void>();

export function subscribeScreenThumbnails(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the room's set of stills with the one the server just reported, so
 *  a share that stopped or a sharer who left drops out of the hover peek. */
export function syncScreenThumbnails(thumbnails: Record<string, string>) {
  screenThumbnailsMap.clear();
  for (const [sharer, thumbnail] of Object.entries(thumbnails)) {
    screenThumbnailsMap.set(sharer, thumbnail);
  }
  listeners.forEach((listener) => listener());
}

export function clearScreenThumbnails() {
  if (screenThumbnailsMap.size === 0) return;
  screenThumbnailsMap.clear();
  listeners.forEach((listener) => listener());
}

/** Who in the room on screen is sharing in a call the viewer is *not* in — the
 *  people a still is for. Someone in the same channel has the live stream and
 *  a "Watch" button, so a still would only ever lag it; someone in another
 *  channel, or in no call at all, has nothing else to see it by. */
export function peekableSharers(
  state: Pick<
    AppState,
    "currentRoomId" | "voiceChannelMembers" | "voiceChannelRooms" | "inVoiceChannel" | "voiceChannelId"
  >,
): Set<string> {
  const ownChannel = state.inVoiceChannel ? state.voiceChannelId : null;
  const sharers = new Set<string>();
  for (const [channelId, members] of Object.entries(state.voiceChannelMembers)) {
    if (channelId === ownChannel || state.voiceChannelRooms[channelId] !== state.currentRoomId) continue;
    for (const member of members) {
      if (member.screen_sharing) sharers.add(member.userId);
    }
  }
  return sharers;
}
