import { useEffect, useSyncExternalStore } from "react";
import { useAppContext, screenThumbnailsMap } from "@/lib/store";
import { apiGetScreenThumbnails } from "@/lib/api";
import {
  clearScreenThumbnails,
  peekableSharers,
  subscribeScreenThumbnails,
  syncScreenThumbnails,
} from "@/lib/screenThumbnail";

/** How often a member outside the call refreshes the room's stills. Slower than
 *  the sharer's own capture cadence: this is a hover peek, and one request per
 *  idle viewer every few seconds is plenty to keep the thumbnail honest. */
const SCREEN_THUMBNAIL_POLL_MS = 4000;

/** Keeps `screenThumbnailsMap` current for the room on screen, so hovering a
 *  sharer — in the members list or under a voice channel — shows what they
 *  have on screen when the viewer is not in that call and therefore has no
 *  stream of their own.
 *
 *  Mounted by the app shell rather than the voice controls: the whole point is
 *  the people who are *not* in the call, and the voice UI is not on screen for
 *  them. A share in the viewer's own channel is left out (`peekableSharers`) —
 *  there the row has a real "Watch" button and a live stream, so a still would
 *  only ever disagree with it. */
export function useScreenShareThumbnails() {
  const { state } = useAppContext();
  const roomId = state.currentRoomId;
  // A string so the effect restarts only when the set itself changes, not on
  // every voice event that rebuilds the members map.
  const sharers = [...peekableSharers(state)].sort().join(",");

  useEffect(() => {
    // Nothing to peek at until someone in this room is sharing outside our call.
    if (!roomId || !sharers) {
      clearScreenThumbnails();
      return;
    }

    const wanted = new Set(sharers.split(","));
    const poll = async () => {
      try {
        const { thumbnails } = await apiGetScreenThumbnails(roomId);
        syncScreenThumbnails(
          Object.fromEntries(Object.entries(thumbnails).filter(([sharer]) => wanted.has(sharer))),
        );
      } catch {
        // A dropped request keeps the last set rather than blanking the peek.
      }
    };

    void poll();
    const timer = setInterval(poll, SCREEN_THUMBNAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [roomId, sharers]);
}

/** The latest still of `userId`'s share, re-rendering as it refreshes, or
 *  `null` when there is none to peek at. */
export function useScreenThumbnail(userId: string | null): string | null {
  return useSyncExternalStore(
    subscribeScreenThumbnails,
    () => (userId ? screenThumbnailsMap.get(userId) ?? null : null),
  );
}
