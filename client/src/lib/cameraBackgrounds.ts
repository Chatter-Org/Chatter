/**
 * What goes behind the person on this device's camera: nothing, a blur, or
 * an image they uploaded. All of it is kept in this browser only — the
 * effect is drawn on the sender's machine (see `backgroundBlur.ts`), so the
 * server never needs the images, and a storage that throws (private windows,
 * blocked site data) just means starting from no effect with no images.
 */

export type CameraEffect =
  | { kind: "none" }
  | { kind: "blur" }
  | { kind: "image"; id: string; src: string };

export interface CameraBackground {
  id: string;
  /** A JPEG data URL, already downscaled. */
  src: string;
}

/** The blur choice from before images existed; still read, never written. */
const LEGACY_BLUR_KEY = "chatter_camera_blur";
const EFFECT_KEY = "chatter_camera_effect";
const BACKGROUNDS_KEY = "chatter_camera_backgrounds";

/** Enough to choose between without filling the browser's storage. */
export const MAX_CAMERA_BACKGROUNDS = 6;

/** Refused before decoding: anything bigger is not a photo meant for this. */
export const MAX_BACKGROUND_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Stored at no more than the camera is sent at; a bigger image is wasted. */
const STORED_MAX_WIDTH = 1280;
const STORED_MAX_HEIGHT = 720;
const STORED_JPEG_QUALITY = 0.85;

export function listCameraBackgrounds(): CameraBackground[] {
  try {
    const raw = localStorage.getItem(BACKGROUNDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is CameraBackground =>
        typeof b?.id === "string" && typeof b?.src === "string" && b.src.startsWith("data:image/"),
    );
  } catch {
    return [];
  }
}

function saveCameraBackgrounds(list: CameraBackground[]) {
  // Unlike the choice, this can fail for a reason worth telling the user
  // (the storage is full), so it throws.
  localStorage.setItem(BACKGROUNDS_KEY, JSON.stringify(list));
}

/** Downscale an uploaded image and keep it. Newest first. */
export async function addCameraBackground(file: File): Promise<CameraBackground> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image.");
  if (file.size > MAX_BACKGROUND_UPLOAD_BYTES) throw new Error("That image is too large (25 MB at most).");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That image couldn't be read.");
  });
  const scale = Math.min(1, STORED_MAX_WIDTH / bitmap.width, STORED_MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare the image.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const background = {
    id: crypto.randomUUID(),
    src: canvas.toDataURL("image/jpeg", STORED_JPEG_QUALITY),
  };
  const list = [background, ...listCameraBackgrounds()].slice(0, MAX_CAMERA_BACKGROUNDS);
  try {
    saveCameraBackgrounds(list);
  } catch {
    throw new Error("There's no room left to keep that image in this browser.");
  }
  return background;
}

export function removeCameraBackground(id: string) {
  try {
    saveCameraBackgrounds(listCameraBackgrounds().filter((b) => b.id !== id));
  } catch {
    // Nothing more to do; it stays until storage works again.
  }
}

/** This device's last choice; an image since deleted counts as none. */
export function readCameraEffect(): CameraEffect {
  try {
    const saved = localStorage.getItem(EFFECT_KEY);
    if (saved === null) {
      return localStorage.getItem(LEGACY_BLUR_KEY) === "1" ? { kind: "blur" } : { kind: "none" };
    }
    if (saved === "blur") return { kind: "blur" };
    if (saved.startsWith("image:")) {
      const id = saved.slice("image:".length);
      const background = listCameraBackgrounds().find((b) => b.id === id);
      if (background) return { kind: "image", id, src: background.src };
    }
  } catch {
    // Unreadable storage: start from off.
  }
  return { kind: "none" };
}

export function saveCameraEffect(effect: CameraEffect) {
  try {
    localStorage.setItem(
      EFFECT_KEY,
      effect.kind === "image" ? `image:${effect.id}` : effect.kind,
    );
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** The image ready to draw behind the camera. */
export function decodeCameraBackground(src: string): Promise<ImageBitmap> {
  return fetch(src)
    .then((r) => r.blob())
    .then((blob) => createImageBitmap(blob));
}
