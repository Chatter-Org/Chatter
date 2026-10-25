import { useEffect, useState } from "react";
import GoogleCast, { CastState, useCastDevice, useCastState, type CastSession, type MediaTrack } from "react-native-google-cast";
import { apiGetServerInfo } from "@chatter/core/api";
import { serverAsset, sessionHeaders } from "./server";
import { showToast } from "./toast";

/**
 * Casting a message's video to a Chromecast — the web's useChromecast on
 * Google's Cast SDK. The receiver is Google's Default Media Receiver, and it
 * fetches the file itself: it cannot send a session, so a server that only
 * shows uploads to signed-in people (require_auth_for_uploads) can't cast, on
 * the web either, and the button is not offered there.
 */

/** The receiver numbers the tracks it finds inside the file from 1; ours
 *  start well clear of them (the web's CAST_TRACK_ID_BASE). */
const TRACK_ID_BASE = 1000;

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  // The server remuxes these to MP4 under their own names.
  mkv: "video/mp4",
};

function fileTitle(url: string): string {
  const last = url.split("?")[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(last).replace(/\.[^.]+$/, "");
  } catch {
    return last;
  }
}

/** The video's WebVTT sidecars, as the server lists them beside it, for the
 *  receiver to fetch and draw. */
async function captionTracks(url: string): Promise<MediaTrack[]> {
  if (!url.includes("/external/")) return [];
  try {
    const res = await fetch(`${url}@subs.json`, { headers: sessionHeaders(url) });
    if (!res.ok) return [];
    const json = (await res.json()) as { tracks?: { src?: unknown; label?: unknown; language?: unknown }[] };
    return (json.tracks ?? []).flatMap((t, i): MediaTrack[] => {
      if (typeof t.src !== "string") return [];
      const language = typeof t.language === "string" && t.language && t.language !== "und" ? t.language : undefined;
      return [
        {
          id: TRACK_ID_BASE + i,
          type: "text",
          subtype: "subtitles",
          contentId: url + t.src,
          contentType: "text/vtt",
          name: typeof t.label === "string" ? t.label : undefined,
          language,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** A session, asking the person to pick a device first if there is none. */
async function session(): Promise<CastSession | null> {
  const manager = GoogleCast.getSessionManager();
  const current = await manager.getCurrentCastSession();
  if (current) return current;
  return new Promise((resolve) => {
    const subs = [
      manager.onSessionStarted((s) => done(s)),
      manager.onSessionStartFailed(() => done(null)),
    ];
    // Closing the picker starts nothing and says nothing; stop waiting then.
    const timer = setTimeout(() => done(null), 60_000);
    function done(s: CastSession | null) {
      clearTimeout(timer);
      subs.forEach((sub) => sub.remove());
      resolve(s);
    }
    void GoogleCast.showCastDialog().then((shown) => {
      if (!shown) done(null);
    });
  });
}

/** Play a message's video on the TV, captions on (the first track), as the
 *  web does, then show the phone's controls for it. */
export async function castVideo(url: string): Promise<void> {
  const contentUrl = serverAsset(url);
  if (!contentUrl) return;
  try {
    const s = await session();
    if (!s) return;
    const client = s.client;
    const ext = contentUrl.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
    const tracks = await captionTracks(contentUrl);
    await client.loadMedia({
      autoplay: true,
      startTime: 0,
      mediaInfo: {
        contentUrl,
        contentType: CONTENT_TYPES[ext] ?? "video/mp4",
        mediaTracks: tracks.length > 0 ? tracks : undefined,
        metadata: { type: "generic", title: fileTitle(contentUrl), images: [{ url: `${contentUrl}.thumb.jpg` }] },
      },
    });
    if (tracks.length > 0) await client.setActiveTrackIds([tracks[0].id]);
    void GoogleCast.showExpandedControls();
  } catch (e) {
    showToast({ message: "Couldn't cast this video", description: e instanceof Error ? e.message : undefined, tone: "error" });
  }
}

let uploadsNeedAuth: Promise<boolean> | null = null;

/** Whether to offer casting: there is a Cast device about, and the server
 *  lets a receiver fetch uploads without a session. */
export function useCast(): { available: boolean; connected: boolean; deviceName: string | null } {
  const state = useCastState();
  const device = useCastDevice();
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    uploadsNeedAuth ??= apiGetServerInfo()
      .then((info) => info.require_auth_for_uploads)
      .catch(() => {
        uploadsNeedAuth = null;
        return true;
      });
    let live = true;
    void uploadsNeedAuth.then((needed) => live && setOpen(!needed));
    return () => {
      live = false;
    };
  }, []);
  const available = open === true && !!state && state !== CastState.NO_DEVICES_AVAILABLE;
  return { available, connected: state === CastState.CONNECTED, deviceName: device?.friendlyName ?? null };
}
