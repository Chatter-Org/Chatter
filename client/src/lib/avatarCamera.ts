/**
 * A 3D avatar in place of the camera. The camera's
 * frames are only looked at here, never sent: MediaPipe's face landmarker
 * reads the head's pose and 52 expression scores ("blendshapes") off each
 * one, those pose a VRM model, and three.js draws it onto a canvas whose
 * frames are what gets published. The SFU and every viewer see an ordinary
 * camera.
 *
 * As with the blur, the runtime and model come from this server's hashed
 * /assets, and this file is only loaded by dynamic import. There is no
 * fallback to the bare camera: an avatar is on because the face is not for
 * sharing, so anything that fails here fails the camera.
 */
import {
  FaceLandmarker,
  PoseLandmarker,
  type Category,
  type FaceLandmarkerResult,
  type Landmark,
} from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import modelAssetPath from "@/assets/models/face_landmarker.task?url";
import poseModelAssetPath from "@/assets/models/pose_landmarker_lite.task?url";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { BlurredCamera, BreakoutBox } from "@/lib/backgroundBlur";
import { AVATAR_ZOOM } from "@/lib/cameraBackgrounds";

/** The avatar is drawn at this size whatever the camera's. */
const WIDTH = 1280;
const HEIGHT = 720;
const BACKGROUND = "#30343c";

/** How far each frame moves toward what the face says, 0–1: lower is
 *  smoother but lags. Blinks are quick, so they follow more closely. */
const SMOOTHING = 0.5;
const BLINK_SMOOTHING = 0.8;

/** Without a face to follow, the avatar still blinks every few seconds. */
const IDLE_BLINK_MS = 150;
const IDLE_BLINK_GAP_MS = [2500, 6000] as const;

/** Each arm's shoulder, elbow and wrist in MediaPipe's pose landmarks, which
 *  name sides as the person's own, as VRM does. */
const ARMS = [
  { upper: "leftUpperArm", lower: "leftLowerArm", points: [11, 13, 15] },
  { upper: "rightUpperArm", lower: "rightLowerArm", points: [12, 14, 16] },
] as const;
/** A point the pose is less sure than this is in view counts as out of it. */
const MIN_VISIBILITY = 0.6;
/** Arms are slower and noisier to read than a face, so they follow more loosely. */
const ARM_SMOOTHING = 0.35;
/** Depth read from one camera is the noisiest part of a pose; only some of it
 *  is used, so an arm does not lunge at the camera. */
const ARM_DEPTH = 0.5;
/** The pose is read on every this many frames, to keep its cost down. */
const POSE_EVERY = 2;

/** VRM's own expression names; three-vrm maps a VRM 0.x model's onto them. */
const EXPRESSIONS = ["blinkLeft", "blinkRight", "aa", "ee", "oh", "ou", "happy", "surprised"] as const;
type Expressions = Record<(typeof EXPRESSIONS)[number], number>;

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
/** The landmarker refuses a timestamp that does not move forward, across
 *  every camera it is given — the picker's preview, then the call's. */
let lastTimestamp = 0;

let poseLandmarkerPromise: Promise<PoseLandmarker | null> | null = null;

/** One pose landmarker for the page, for the arms. Without it the arms rest,
 *  which is no reason to fail the camera. */
function loadPoseLandmarker(): Promise<PoseLandmarker | null> {
  poseLandmarkerPromise ??= (async () => {
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: poseModelAssetPath, delegate },
      runningMode: "VIDEO" as const,
      numPoses: 1,
    });
    try {
      return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      return await PoseLandmarker.createFromOptions(fileset, options("CPU"));
    }
  })().catch((err) => {
    console.warn("[avatar] arm tracking unavailable:", err);
    poseLandmarkerPromise = null;
    return null;
  });
  return poseLandmarkerPromise;
}

/** One landmarker for the page; building it is the slow part. */
function loadLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= (async () => {
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      return await FaceLandmarker.createFromOptions(fileset, options("CPU"));
    }
  })().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

async function loadVrm(data: ArrayBuffer): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(data, "").catch(() => {
    throw new Error("That avatar couldn't be read. Is it a .vrm file?");
  });
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    VRMUtils.deepDispose(gltf.scene);
    throw new Error("That file is a 3D model but not a VRM avatar.");
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  // VRM 0.x models face the other way.
  VRMUtils.rotateVRM0(vrm);
  // Skinned meshes are culled by their rest pose; the camera is close enough
  // for a turned head to leave it.
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  return vrm;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Eyes are rarely reported fully open or shut; stretch the middle out. */
const eyeClosed = (v: number) => clamp((v - 0.3) / 0.35);

/** The face's expression scores as VRM expressions. */
function expressionsFrom(categories: Category[]): Expressions {
  const scores = new Map(categories.map((c) => [c.categoryName, c.score]));
  const s = (name: string) => scores.get(name) ?? 0;
  return {
    // MediaPipe names each side as it appears in the image, the reverse of
    // the avatar's own left and right.
    blinkLeft: eyeClosed(s("eyeBlinkRight")),
    blinkRight: eyeClosed(s("eyeBlinkLeft")),
    aa: clamp(s("jawOpen") * 1.6),
    ee: clamp((s("mouthStretchLeft") + s("mouthStretchRight")) * 1.2),
    oh: clamp(s("mouthFunnel") * 1.5),
    ou: clamp(s("mouthPucker") * 1.2),
    happy: clamp(((s("mouthSmileLeft") + s("mouthSmileRight")) / 2 - 0.2) * 1.6),
    surprised: clamp((s("browInnerUp") - 0.4) * 1.6),
  };
}

/**
 * A VRM 0.x model faces -Z in its own space (three-vrm turns its scene round
 * to face the camera, but its bones keep their axes), so a turn about X or Z
 * goes the other way on it; about Y it is the same either way.
 */
const isVrm0 = (vrm: VRM) => vrm.meta?.metaVersion === "0";

/**
 * Moves the avatar toward what each reading says: the head (shared with the
 * neck, so it does not turn on a stick), the face, and the arms while they
 * are in view. Called once a frame, after `poseAndFrame` has put the arms at
 * rest.
 */
function makeRig(vrm: VRM) {
  const neck = vrm.humanoid.getNormalizedBoneNode("neck");
  const head = vrm.humanoid.getNormalizedBoneNode("head");
  const identity = new THREE.Quaternion();
  const headTarget = new THREE.Quaternion();
  const headNow = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const values = Object.fromEntries(EXPRESSIONS.map((name) => [name, 0])) as Expressions;
  const vrm0 = isVrm0(vrm);
  let nextBlinkAt = performance.now() + IDLE_BLINK_GAP_MS[0];

  const arms = ARMS.map(({ upper, lower, points }) => {
    const upperBone = vrm.humanoid.getNormalizedBoneNode(upper);
    // Out to its own side in the T-pose: +X for the left arm of a model
    // facing +Z, the other way for the right, and both reversed for 0.x.
    const side = (upper === "leftUpperArm" ? 1 : -1) * (vrm0 ? -1 : 1);
    return {
      upperBone,
      lowerBone: vrm.humanoid.getNormalizedBoneNode(lower),
      points,
      along: new THREE.Vector3(side, 0, 0),
      rest: upperBone?.quaternion.clone() ?? new THREE.Quaternion(),
      upperTarget: new THREE.Quaternion(),
      lowerTarget: new THREE.Quaternion(),
    };
  });
  const shoulder = new THREE.Vector3();
  const elbow = new THREE.Vector3();
  const wrist = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const undo = new THREE.Quaternion();
  const seen = (p: Landmark | undefined): p is Landmark => p !== undefined && p.visibility >= MIN_VISIBILITY;
  // MediaPipe's world landmarks are in metres with Y down and Z away from the
  // camera; the model's space has Y up and faces +Z (-Z for 0.x).
  const toModel = (p: Landmark, out: THREE.Vector3) =>
    vrm0 ? out.set(-p.x, -p.y, p.z * ARM_DEPTH) : out.set(p.x, -p.y, -p.z * ARM_DEPTH);

  const poseArms = (pose: Landmark[] | null) => {
    for (const arm of arms) {
      if (!arm.upperBone) continue;
      const [s, e, w] = arm.points.map((i) => pose?.[i]);
      if (seen(s) && seen(e)) {
        toModel(s, shoulder);
        toModel(e, elbow);
        arm.upperTarget.setFromUnitVectors(arm.along, direction.subVectors(elbow, shoulder).normalize());
        if (seen(w)) {
          // The forearm turns from where the upper arm already points.
          toModel(w, wrist);
          direction.subVectors(wrist, elbow).normalize().applyQuaternion(undo.copy(arm.upperTarget).invert());
          arm.lowerTarget.setFromUnitVectors(arm.along, direction);
        } else {
          arm.lowerTarget.identity();
        }
      } else {
        arm.upperTarget.copy(arm.rest);
        arm.lowerTarget.identity();
      }
      arm.upperBone.quaternion.slerp(arm.upperTarget, ARM_SMOOTHING);
      arm.lowerBone?.quaternion.slerp(arm.lowerTarget, ARM_SMOOTHING);
    }
  };

  const idle = (nowMs: number): Expressions => {
    if (nowMs >= nextBlinkAt + IDLE_BLINK_MS) {
      const [min, max] = IDLE_BLINK_GAP_MS;
      nextBlinkAt = nowMs + min + Math.random() * (max - min);
    }
    const blink = nowMs >= nextBlinkAt ? 1 : 0;
    const rest = Object.fromEntries(EXPRESSIONS.map((name) => [name, 0])) as Expressions;
    return { ...rest, blinkLeft: blink, blinkRight: blink };
  };

  return (result: FaceLandmarkerResult | null, pose: Landmark[] | null, deltaS: number, nowMs: number) => {
    const face = result?.faceBlendshapes?.[0];
    const transform = result?.facialTransformationMatrixes?.[0];
    let target: Expressions;
    if (face && transform) {
      // The face's pose in the camera's space, where it looks back along +Z
      // as a VRM 1.0 model does at its own camera, so it applies as it is.
      matrix.fromArray(transform.data).decompose(position, headTarget, scale);
      if (vrm0) {
        // Turned half round about Y for a model that faces -Z.
        headTarget.x = -headTarget.x;
        headTarget.z = -headTarget.z;
      }
      target = expressionsFrom(face.categories);
    } else {
      // Lost the face: settle back to looking ahead.
      headTarget.identity();
      target = idle(nowMs);
    }
    headNow.slerp(headTarget, SMOOTHING);
    neck?.quaternion.slerpQuaternions(identity, headNow, 0.4);
    head?.quaternion.slerpQuaternions(identity, headNow, neck ? 0.6 : 1);
    for (const name of EXPRESSIONS) {
      const k = name.startsWith("blink") ? BLINK_SMOOTHING : SMOOTHING;
      values[name] += (target[name] - values[name]) * k;
      vrm.expressionManager?.setValue(name, values[name]);
    }
    poseArms(pose);
    // Also runs the hair and clothes' spring bones; a long gap (a stalled
    // camera) would fling them.
    vrm.update(Math.min(deltaS, 0.1));
  };
}

export interface AvatarCamera extends BlurredCamera {
  /** Moves the camera in (above 1) or out (below), from the next frame. */
  setZoom: (zoom: number) => void;
}

/**
 * Arms down from the T-pose models are made in, and the camera on the face.
 * Returns what moves the camera in and out.
 */
function poseAndFrame(vrm: VRM, camera: THREE.PerspectiveCamera): (zoom: number) => void {
  // In a VRM 1.0 model's own space it faces +Z, its left arm points along +X,
  // and a turn about Z brings it down; a 0.x model is the other way round.
  const down = isVrm0(vrm) ? -1.2 : 1.2;
  const leftArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
  const rightArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
  if (leftArm) leftArm.rotation.z = -down;
  if (rightArm) rightArm.rotation.z = down;
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);

  const head = vrm.humanoid.getRawBoneNode("head");
  if (!head) throw new Error("That avatar has no head to move.");
  const at = head.getWorldPosition(new THREE.Vector3());
  // At 1, head and shoulders with room around them, as a webcam frames a
  // person. The head bone is at the base of the skull.
  return (zoom) => {
    const z = Math.min(AVATAR_ZOOM.max, Math.max(AVATAR_ZOOM.min, zoom));
    camera.position.set(at.x, at.y - 0.02, at.z + 1.6 / z);
    camera.lookAt(at.x, at.y - 0.08, at.z);
  };
}

/** `image` cropped to fill the frame, as a backdrop for the avatar. */
function backdropTexture(image: ImageBitmap): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This computer can't draw the avatar's background.");
  const cover = Math.max(WIDTH / image.width, HEIGHT / image.height);
  const w = image.width * cover;
  const h = image.height * cover;
  ctx.drawImage(image, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The avatar's scene: `draw` reads the face (and every other frame, the
 * arms) off a camera frame, poses the avatar from them and renders it onto
 * `canvas`. Owns everything it is given;
 * `dispose` lets it all go.
 */
function makeScene(
  landmarker: FaceLandmarker,
  poseLandmarker: PoseLandmarker | null,
  vrm: VRM,
  backdrop: THREE.CanvasTexture | null,
  zoom: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  let renderer: THREE.WebGLRenderer;
  try {
    // Kept after each draw, so the frame copied from it is the one just drawn.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch {
    VRMUtils.deepDispose(vrm.scene);
    throw new Error("This device can't draw the avatar (no WebGL).");
  }
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const scene = new THREE.Scene();
  scene.background = backdrop ?? new THREE.Color(BACKGROUND);
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(0.5, 1, 2);
  scene.add(light, vrm.scene);
  const camera = new THREE.PerspectiveCamera(30, WIDTH / HEIGHT, 0.05, 20);
  const dispose = () => {
    VRMUtils.deepDispose(vrm.scene);
    backdrop?.dispose();
    renderer.dispose();
  };
  let setZoom: (zoom: number) => void;
  try {
    setZoom = poseAndFrame(vrm, camera);
  } catch (err) {
    dispose();
    throw err;
  }
  setZoom(zoom);
  const rig = makeRig(vrm);
  let frames = 0;
  let pose: Landmark[] | null = null;

  const draw = (frame: VideoFrame | HTMLVideoElement, deltaS: number) => {
    const nowMs = performance.now();
    lastTimestamp = Math.max(nowMs, lastTimestamp + 1);
    let result: FaceLandmarkerResult | null = null;
    try {
      result = landmarker.detectForVideo(frame, lastTimestamp);
    } catch {
      // No reading this frame; the avatar carries on as if the face were lost.
    }
    // In between, the arms keep heading for the last reading.
    if (poseLandmarker && frames++ % POSE_EVERY === 0) {
      try {
        pose = poseLandmarker.detectForVideo(frame, lastTimestamp).worldLandmarks[0] ?? null;
      } catch {
        pose = null;
      }
    }
    rig(result, pose, deltaS, nowMs);
    renderer.render(scene, camera);
  };

  return { canvas, draw, dispose, setZoom };
}

type AvatarScene = ReturnType<typeof makeScene>;

/**
 * Chromium (Chrome, Edge, the desktop app): the camera's frames in, the
 * avatar's out, as they come, which keeps going in a background tab.
 */
function avatarWithBreakoutBox(
  box: Required<BreakoutBox>,
  avatar: AvatarScene,
  source: MediaStreamTrack,
  fps: number,
): AvatarCamera {
  const reader = new box.MediaStreamTrackProcessor({ track: source, maxBufferSize: 1 }).readable.getReader();
  const generator = new box.MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  const minGapUs = (1_000_000 / fps) * 0.9;
  let lastUs = -Infinity;
  let stopped = false;

  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        if (stopped || frame.timestamp - lastUs < minGapUs) continue;
        const deltaS = lastUs === -Infinity ? 0 : (frame.timestamp - lastUs) / 1_000_000;
        lastUs = frame.timestamp;
        avatar.draw(frame, deltaS);
        await writer.write(new VideoFrame(avatar.canvas, { timestamp: frame.timestamp }));
      } catch {
        // The track was stopped under us; the loop's condition ends it.
      } finally {
        frame.close();
      }
    }
    // Only once the loop is done with them.
    avatar.dispose();
  })();

  return {
    track: generator,
    setZoom: avatar.setZoom,
    stop: () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
      source.stop();
    },
  };
}

/**
 * Firefox and Safari: the camera played into a video element, the avatar
 * drawn on a worker's clock, and the canvas streamed. As with the blur, the
 * canvas stream only sends when the page paints, so the camera can stall
 * while the sender's tab is hidden.
 */
async function avatarWithCanvasStream(
  avatar: AvatarScene,
  source: MediaStreamTrack,
  fps: number,
): Promise<AvatarCamera> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  try {
    await video.play();
  } catch (err) {
    avatar.dispose();
    throw err;
  }
  const track = avatar.canvas.captureStream(fps).getVideoTracks()[0];

  const tickSource = `setInterval(() => postMessage(0), ${Math.max(1, Math.round(1000 / fps))});`;
  const tickUrl = URL.createObjectURL(new Blob([tickSource], { type: "text/javascript" }));
  const ticker = new Worker(tickUrl);
  let lastMs = performance.now();
  ticker.onmessage = () => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const now = performance.now();
    avatar.draw(video, (now - lastMs) / 1000);
    lastMs = now;
  };

  let stopped = false;
  return {
    track,
    setZoom: avatar.setZoom,
    stop: () => {
      if (stopped) return;
      stopped = true;
      ticker.terminate();
      URL.revokeObjectURL(tickUrl);
      source.stop();
      track.stop();
      video.srcObject = null;
      avatar.dispose();
    },
  };
}

/**
 * Draw the VRM avatar in `model`, following the face in `source`, at up to
 * `fps` frames a second, in front of `image` (closed once drawn) or a plain
 * backdrop, with the camera at `zoom` (`AVATAR_ZOOM`). A camera unplugged
 * or revoked ends `source`, not the returned track: whoever holds the source
 * watches it and calls `stop`.
 */
export async function startAvatarCamera(
  source: MediaStreamTrack,
  fps: number,
  model: ArrayBuffer,
  image?: ImageBitmap,
  zoom: number = AVATAR_ZOOM.default,
): Promise<AvatarCamera> {
  let backdrop: THREE.CanvasTexture | null = null;
  try {
    if (image) backdrop = backdropTexture(image);
    const [landmarker, poseLandmarker, vrm] = await Promise.all([
      loadLandmarker(),
      loadPoseLandmarker(),
      loadVrm(model),
    ]);
    const avatar = makeScene(landmarker, poseLandmarker, vrm, backdrop, zoom);
    const box = globalThis as unknown as BreakoutBox;
    if (box.MediaStreamTrackProcessor && box.MediaStreamTrackGenerator && typeof VideoFrame !== "undefined") {
      return avatarWithBreakoutBox(box as Required<BreakoutBox>, avatar, source, fps);
    }
    return await avatarWithCanvasStream(avatar, source, fps);
  } catch (err) {
    backdrop?.dispose();
    throw err;
  } finally {
    // Copied onto the backdrop's own canvas by now, so it is done with.
    image?.close();
  }
}
