/**
 * What a URL points at, decided by its extension.
 *
 * These lived inside MessageItem, where the chat timeline was the only thing
 * that needed to tell a picture from a video. The forum needs the same answer,
 * and two copies of the list is how the two surfaces end up disagreeing about
 * whether a .mov is a video.
 */
export const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
export const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|mkv)(\?.*)?$/i;
// `weba` and `oga` are the audio-only spellings of WebM and Ogg: what a voice
// message is saved as, so it is not mistaken for a video by the line above.
export const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|aac|m4a|weba|oga|opus)(\?.*)?$/i;

export function isImageUrl(url: string): boolean {
  return IMAGE_EXTENSIONS.test(url);
}

export function isVideoUrl(url: string): boolean {
  return VIDEO_EXTENSIONS.test(url);
}

export function isAudioUrl(url: string): boolean {
  return AUDIO_EXTENSIONS.test(url);
}

/**
 * How the forum lays out a file it has been given: in the gallery as a picture
 * or a clip, or as a download.
 *
 * Judged on the type *and* the name. A browser reports `image/tiff` and
 * `image/heic` as images it cannot draw, and a picture slot holding one is a
 * broken square — so only what the chat would also draw inline is media, and
 * everything else is a file, which any browser can at least download.
 */
export function forumAttachmentKind(file: { name: string; type: string }): "image" | "video" | "file" {
  if (file.type.startsWith("image/") && isImageUrl(file.name)) return "image";
  if (file.type.startsWith("video/") && isVideoUrl(file.name)) return "video";
  return "file";
}

/** Uploaded forum attachments sorted into the three lists a post carries,
 *  each in the order the files were added. */
export function sortForumAttachments(uploaded: { file: { name: string; type: string }; url: string }[]): {
  imageUrls: string[];
  videoUrls: string[];
  fileUrls: string[];
} {
  const sorted = { imageUrls: [] as string[], videoUrls: [] as string[], fileUrls: [] as string[] };
  for (const { file, url } of uploaded) {
    const kind = forumAttachmentKind(file);
    (kind === "image" ? sorted.imageUrls : kind === "video" ? sorted.videoUrls : sorted.fileUrls).push(url);
  }
  return sorted;
}

/**
 * An upload the server may rewrite under its own name (`is_rewritten_in_place`
 * in media.rs): `/external/<32 hex folder>/<file>` with one of these
 * extensions. The folder is what makes it one of this server's uploads; a
 * video linked from anywhere else is left exactly as it was given.
 */
const REWRITTEN_UPLOAD_VIDEO = /\/external\/[0-9a-f]{32}\/[^/?#]+\.(?:mp4|mov|m4v|webm|mkv|avi|wmv|flv|ts)(?:[?#]|$)/i;

/** Ignored by the server. Changed only if copies cached under it go stale
 *  with nothing on the server able to reach them; `indexed=1` was the first,
 *  and it covered WebM alone. */
const PLAYBACK_CACHE_KEY = "cache=2";

/**
 * The URL a player should load an uploaded video from.
 *
 * The server rewrites uploads in place: it fills in the duration a
 * `MediaRecorder` WebM never wrote, and it re-encodes an MP4, MOV or
 * converted MKV whose picture no browser draws (HEVC, 10-bit or 4:2:2 H.264).
 * Uploads were served `immutable` for a year, so a browser that had fetched
 * one before its repair kept playing the old copy — a clip it could not seek,
 * or sound over a black picture with a thumbnail that looked fine, since the
 * thumbnail revalidates. The server now revalidates these; the query gives
 * the copies pinned before that a cache key they have never seen. Only the
 * player's `src`: thumbnails and caption sidecars are derived from the bare
 * URL.
 */
export function videoPlaybackUrl(url: string): string {
  if (!REWRITTEN_UPLOAD_VIDEO.test(url)) return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${PLAYBACK_CACHE_KEY}${fragment}`;
}
