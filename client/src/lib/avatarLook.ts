/**
 * The avatar's settings that its drawing needs, with nothing else: kept apart
 * from `cameraBackgrounds.ts` (which re-exports them) so that streamer mode's
 * worker can import the avatar without the store, storage and desktop bridge.
 */

/** Where the avatar's light comes from, as the viewer sees it. */
export type AvatarLightFrom = "front" | "left" | "right" | "above";

/** How the avatar is lit and outlined; models are made for different
 *  lighting, so it is kept per avatar, as the zoom is. */
export interface AvatarLook {
  /** The light's strength, 1 as the avatar was first drawn. */
  brightness: number;
  lightFrom: AvatarLightFrom;
  /** An outline drawn round the model, 0 for none and 1 the thickest. Any
   *  outline the model has of its own is drawn either way. */
  outline: number;
}

/** How close the avatar's camera is: 1 frames a person-sized model's head
 *  and shoulders. Here rather than in `avatarCamera.ts` so the picker can
 *  use it without loading three.js. */
export const AVATAR_ZOOM = { min: 0.4, max: 2, default: 1 } as const;
export const AVATAR_BRIGHTNESS = { min: 0.4, max: 2 } as const;
export const AVATAR_LIGHTS: AvatarLightFrom[] = ["front", "left", "right", "above"];
export const DEFAULT_AVATAR_LOOK: AvatarLook = { brightness: 1, lightFrom: "front", outline: 0 };
