import { useState, useEffect, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BlurredCamera } from "@/lib/backgroundBlur";
import {
  addCameraBackground,
  decodeCameraBackground,
  listCameraBackgrounds,
  MAX_CAMERA_BACKGROUNDS,
  readAvatar,
  readCameraAvatar,
  readCameraEffect,
  removeCameraBackground,
  saveCameraAvatar,
  saveCameraEffect,
  type CameraBackgroundEffect,
  type CameraEffect,
} from "@/lib/cameraBackgrounds";
import { avatarStore, type StoredAvatar } from "@/lib/avatarStore";
import { Ban, Droplets, FolderOpen, ImagePlus, Plus, UserRound, X } from "lucide-react";

interface CameraSelectModalProps {
  open: boolean;
  onClose: () => void;
  onStart: (deviceId: string, fps: 30 | 60, effect: CameraEffect) => void;
}

const FPS_OPTIONS: Array<30 | 60> = [30, 60];

const TILE =
  "relative flex aspect-video items-center justify-center overflow-hidden rounded-md border-2 bg-muted text-muted-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export function CameraSelectModal({ open, onClose, onStart }: CameraSelectModalProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [fps, setFps] = useState<30 | 60>(30);
  // null while unknown — browsers that do not report track capabilities get
  // both options rather than a silently missing one.
  const [maxDeviceFps, setMaxDeviceFps] = useState<number | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  // The background, and the avatar in front of it if there is one; an image
  // goes behind an avatar, a blur does not (there is no room to blur).
  const [effect, setEffect] = useState<CameraBackgroundEffect>(readCameraEffect);
  const [avatarId, setAvatarId] = useState<string | null>(readCameraAvatar);
  const [backgrounds, setBackgrounds] = useState(listCameraBackgrounds);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The preview through the effect, so what you see is what the call will see.
  const [blurredPreview, setBlurredPreview] = useState<BlurredCamera | null>(null);
  const [effectFailed, setEffectFailed] = useState(false);
  // This device's avatars; null until listed, and always where there is nowhere to keep them.
  const [avatars, setAvatars] = useState<StoredAvatar[] | null>(null);
  // Loading the chosen avatar failed (blocks starting), or adding or removing one did.
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarFileError, setAvatarFileError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // An avatar never falls back to the bare camera, so it counts even when broken.
  const hasEffect = avatarId !== null || (effect.kind !== "none" && !effectFailed);
  // What the call will send.
  const chosen = useMemo<CameraEffect>(
    () =>
      avatarId
        ? { kind: "avatar", id: avatarId, backgroundSrc: effect.kind === "image" ? effect.src : undefined }
        : effect,
    [avatarId, effect],
  );

  // Cameras often report 59.94 (NTSC) rather than a flat 60, so allow a
  // little slack instead of hiding the option from them.
  const supports60 = maxDeviceFps === null || maxDeviceFps >= 59;

  // When modal opens, request permission then enumerate devices
  useEffect(() => {
    if (!open) {
      stopPreview();
      return;
    }
    setPermissionError(false);
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        // Permission granted — enumerate to get labels
        return navigator.mediaDevices.enumerateDevices().then((all) => {
          const cams = all.filter((d) => d.kind === "videoinput");
          setDevices(cams);
          const defaultId = cams[0]?.deviceId || "";
          setSelectedDeviceId(defaultId);
          // Stop the initial permission stream; we'll start a preview with the selected device
          stream.getTracks().forEach((t) => t.stop());
        });
      })
      .catch(() => {
        setPermissionError(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The avatars, kept current while the folder changes under us.
  useEffect(() => {
    if (!open || !avatarStore) return;
    const avatarsApi = avatarStore;
    let cancelled = false;
    const refresh = () =>
      avatarsApi
        .list()
        .then((list) => !cancelled && setAvatars(list))
        .catch(() => !cancelled && setAvatars([]));
    void refresh();
    const unsubscribe = avatarsApi.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  // An avatar whose file has gone is no longer a choice.
  useEffect(() => {
    if (avatars && avatarId && !avatars.some((a) => a.id === avatarId)) setAvatarId(null);
  }, [avatars, avatarId]);

  // Start/restart preview when selected device changes
  useEffect(() => {
    if (!open || !selectedDeviceId) return;
    stopPreview();

    const constraints: MediaStreamConstraints = {
      video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
    };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        setPreviewStream(stream);
        const track = stream.getVideoTracks()[0];
        const max = track?.getCapabilities?.().frameRate?.max;
        setMaxDeviceFps(typeof max === "number" ? max : null);
      })
      .catch(() => {
        setPreviewStream(null);
        setMaxDeviceFps(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId, open]);

  // Run the preview through the effect while one is on. It works on a
  // clone, so turning the effect off (which stops what it was given) leaves
  // the preview going.
  useEffect(() => {
    const source = chosen.kind !== "none" ? previewStream?.getVideoTracks()[0] : undefined;
    if (!source) return;
    let cancelled = false;
    let blurred: BlurredCamera | null = null;
    const clone = source.clone();
    const started =
      chosen.kind === "avatar"
        ? Promise.all([
            import("@/lib/avatarCamera"),
            readAvatar(chosen.id),
            chosen.backgroundSrc ? decodeCameraBackground(chosen.backgroundSrc) : undefined,
          ]).then(([{ startAvatarCamera }, model, image]) => startAvatarCamera(clone, 30, model, image))
        : Promise.all([
            import("@/lib/backgroundBlur"),
            chosen.kind === "image" ? decodeCameraBackground(chosen.src) : undefined,
          ]).then(([{ blurBackground }, image]) => blurBackground(clone, 30, image));
    setAvatarError(null);
    started
      .then((b) => {
        if (cancelled) {
          b.stop();
          return;
        }
        blurred = b;
        if (chosen.kind !== "avatar") setEffectFailed(false);
        setBlurredPreview(b);
      })
      .catch((err) => {
        console.warn("[camera] camera effect unavailable:", err);
        clone.stop();
        if (cancelled) return;
        if (chosen.kind === "avatar") {
          setAvatarError(err instanceof Error ? err.message : "That avatar couldn't be loaded.");
        } else {
          setEffectFailed(true);
        }
      });
    return () => {
      cancelled = true;
      blurred?.stop();
      setBlurredPreview(null);
    };
  }, [chosen, previewStream]);

  const blurredStream = useMemo(
    () => (blurredPreview ? new MediaStream([blurredPreview.track]) : null),
    [blurredPreview],
  );
  // While an effect loads there is nothing to show rather than the bare
  // camera — it is on precisely because the room behind is not for sharing.
  const shownStream = hasEffect ? blurredStream : previewStream;

  // Attach stream to video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = shownStream;
      if (shownStream) videoRef.current.play().catch(() => {});
    }
  }, [shownStream]);

  function stopPreview() {
    setPreviewStream((prev) => {
      if (prev) prev.getTracks().forEach((t) => t.stop());
      return null;
    });
  }

  async function handleUpload(file: File) {
    setUploadError(null);
    try {
      const background = await addCameraBackground(file);
      setBackgrounds(listCameraBackgrounds());
      setEffect({ kind: "image", id: background.id, src: background.src });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "That image couldn't be added.");
    }
  }

  async function handleAddAvatars() {
    if (!avatarStore) return;
    setAvatarFileError(null);
    try {
      const added = await avatarStore.add();
      if (added.length === 0) return;
      setAvatars(await avatarStore.list());
      selectAvatar(added[0].id);
    } catch (err) {
      setAvatarFileError(err instanceof Error ? err.message : "That avatar couldn't be added.");
    }
  }

  async function handleRemoveAvatar(id: string) {
    if (!avatarStore) return;
    setAvatarFileError(null);
    try {
      await avatarStore.remove(id);
      setAvatars(await avatarStore.list());
    } catch (err) {
      setAvatarFileError(err instanceof Error ? err.message : "That avatar couldn't be removed.");
    }
  }

  function selectAvatar(id: string | null) {
    setAvatarId(id);
    if (id && effect.kind === "blur") setEffect({ kind: "none" });
  }

  function handleRemove(id: string) {
    removeCameraBackground(id);
    setBackgrounds(listCameraBackgrounds());
    if (effect.kind === "image" && effect.id === id) setEffect({ kind: "none" });
  }

  function handleStart() {
    stopPreview();
    saveCameraEffect(effect);
    saveCameraAvatar(avatarId);
    // Segmenting every frame twice as often is more than most machines can
    // keep up with, so an effect sends at 30.
    onStart(selectedDeviceId, supports60 && !hasEffect ? fps : 30, hasEffect ? chosen : { kind: "none" });
    onClose();
  }

  function handleClose() {
    stopPreview();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Select Camera</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {permissionError ? (
            <p className="text-sm text-destructive">
              Camera access was denied. Please allow camera access in your browser settings.
            </p>
          ) : (
            <>
              {devices.length > 1 && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">Camera device</label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Frame rate</label>
                <div className="flex gap-2">
                  {FPS_OPTIONS.map((option) => {
                    const disabled = option === 60 && (!supports60 || hasEffect);
                    return (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={(fps === option || hasEffect) && !disabled ? "default" : "outline"}
                        disabled={disabled}
                        onClick={() => setFps(option)}
                        className="flex-1 text-xs"
                      >
                        {option} FPS
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {!supports60
                    ? "This camera only reports support for 30 FPS."
                    : hasEffect
                      ? avatarId
                        ? "Avatars send at 30 FPS."
                        : "Background effects send at 30 FPS."
                      : "60 FPS is smoother but uses more bandwidth."}
                </p>
              </div>

              {avatarStore && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Avatar</label>
                    {avatarStore.openFolder && (
                      <button
                        type="button"
                        onClick={() => avatarStore?.openFolder?.()}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                        title="Show the avatars folder"
                      >
                        <FolderOpen className="h-3 w-3" />
                        Open folder
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => selectAvatar(null)}
                      className={cn(TILE, avatarId === null ? "border-primary" : "border-transparent hover:border-border")}
                      title="No avatar"
                    >
                      <Ban className="h-4 w-4" />
                    </button>
                    {(avatars ?? []).map((a) => (
                      <div key={a.id} className="group relative">
                        <button
                          type="button"
                          onClick={() => selectAvatar(a.id)}
                          className={cn(
                            TILE,
                            "w-full flex-col gap-1 px-1",
                            avatarId === a.id
                              ? "border-primary"
                              : "border-transparent hover:border-border",
                          )}
                          title={a.name}
                        >
                          <UserRound className="h-4 w-4 shrink-0" />
                          <span className="w-full truncate text-[10px] leading-tight">{a.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveAvatar(a.id)}
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow ring-1 ring-border hover:text-foreground can-hover:opacity-0 can-hover:group-hover:opacity-100 cursor-pointer"
                          title={avatarStore?.openFolder ? "Move this avatar to the trash" : "Remove this avatar"}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleAddAvatars()}
                      className={cn(TILE, "border-dashed border-border hover:text-foreground")}
                      title="Add a VRM avatar"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <p
                    className={cn(
                      "text-xs",
                      avatarError || avatarFileError ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {avatarError ??
                      avatarFileError ??
                      "A 3D avatar (a .vrm file) follows your face in place of your camera. The avatar and the camera's picture stay on this device."}
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Background</label>
                <div className="grid grid-cols-4 gap-2">
                  {(["none", "blur"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={kind === "blur" && (effectFailed || avatarId !== null)}
                      onClick={() => setEffect({ kind })}
                      className={cn(
                        TILE,
                        effect.kind === kind ? "border-primary" : "border-transparent hover:border-border",
                      )}
                      title={
                        kind === "none"
                          ? "No effect"
                          : avatarId
                            ? "Blur isn't used with an avatar"
                            : "Blur background"
                      }
                    >
                      {kind === "none" ? <Ban className="h-4 w-4" /> : <Droplets className="h-4 w-4" />}
                    </button>
                  ))}
                  {backgrounds.map((b) => (
                    <div key={b.id} className="group relative">
                      <button
                        type="button"
                        disabled={effectFailed && !avatarId}
                        onClick={() => setEffect({ kind: "image", id: b.id, src: b.src })}
                        className={cn(
                          TILE,
                          "w-full",
                          effect.kind === "image" && effect.id === b.id
                            ? "border-primary"
                            : "border-transparent hover:border-border",
                        )}
                        title="Use this background"
                      >
                        <img src={b.src} alt="" className="h-full w-full object-cover" draggable={false} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(b.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow ring-1 ring-border hover:text-foreground can-hover:opacity-0 can-hover:group-hover:opacity-100 cursor-pointer"
                        title="Remove this background"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {backgrounds.length < MAX_CAMERA_BACKGROUNDS && (
                    <button
                      type="button"
                      disabled={effectFailed && !avatarId}
                      onClick={() => fileInputRef.current?.click()}
                      className={cn(TILE, "border-dashed border-border hover:text-foreground")}
                      title="Upload a background image"
                    >
                      <ImagePlus className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Cleared so picking the same file again still fires.
                    e.target.value = "";
                    if (file) void handleUpload(file);
                  }}
                />
                <p className={cn("text-xs", uploadError ? "text-destructive" : "text-muted-foreground")}>
                  {uploadError ??
                    (avatarId
                      ? "An image goes behind your avatar; without one it stands on plain grey."
                      : effectFailed
                        ? "Background effects aren't available on this device."
                        : "Done on this device, and images stay in this browser. The first time takes a moment to load.")}
                </p>
              </div>

              <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                {shownStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
                    {!selectedDeviceId
                      ? "No camera found"
                      : previewStream && avatarId
                        ? avatarError
                          ? "Avatar unavailable"
                          : "Loading avatar..."
                        : previewStream && hasEffect
                          ? "Loading background..."
                        : "Loading preview..."}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleStart}
              disabled={permissionError || !selectedDeviceId || (avatarId !== null && avatarError !== null)}
            >
              Start Camera
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
