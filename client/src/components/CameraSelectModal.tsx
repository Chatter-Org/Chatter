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
  readCameraEffect,
  removeCameraBackground,
  saveCameraEffect,
  type CameraEffect,
} from "@/lib/cameraBackgrounds";
import { Ban, Droplets, ImagePlus, X } from "lucide-react";

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
  const [effect, setEffect] = useState<CameraEffect>(readCameraEffect);
  const [backgrounds, setBackgrounds] = useState(listCameraBackgrounds);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The preview through the effect, so what you see is what the call will see.
  const [blurredPreview, setBlurredPreview] = useState<BlurredCamera | null>(null);
  const [effectFailed, setEffectFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasEffect = effect.kind !== "none" && !effectFailed;

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
    const source = effect.kind !== "none" ? previewStream?.getVideoTracks()[0] : undefined;
    if (!source) return;
    let cancelled = false;
    let blurred: BlurredCamera | null = null;
    const clone = source.clone();
    Promise.all([
      import("@/lib/backgroundBlur"),
      effect.kind === "image" ? decodeCameraBackground(effect.src) : undefined,
    ])
      .then(([{ blurBackground }, image]) => blurBackground(clone, 30, image))
      .then((b) => {
        if (cancelled) {
          b.stop();
          return;
        }
        blurred = b;
        setEffectFailed(false);
        setBlurredPreview(b);
      })
      .catch((err) => {
        console.warn("[camera] background effect unavailable:", err);
        clone.stop();
        if (!cancelled) setEffectFailed(true);
      });
    return () => {
      cancelled = true;
      blurred?.stop();
      setBlurredPreview(null);
    };
  }, [effect, previewStream]);

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

  function handleRemove(id: string) {
    removeCameraBackground(id);
    setBackgrounds(listCameraBackgrounds());
    if (effect.kind === "image" && effect.id === id) setEffect({ kind: "none" });
  }

  function handleStart() {
    stopPreview();
    saveCameraEffect(effect);
    // Segmenting every frame twice as often is more than most machines can
    // keep up with, so an effect sends at 30.
    onStart(selectedDeviceId, supports60 && !hasEffect ? fps : 30, hasEffect ? effect : { kind: "none" });
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
                      ? "Background effects send at 30 FPS."
                      : "60 FPS is smoother but uses more bandwidth."}
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Background</label>
                <div className="grid grid-cols-4 gap-2">
                  {(["none", "blur"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={kind === "blur" && effectFailed}
                      onClick={() => setEffect({ kind })}
                      className={cn(
                        TILE,
                        effect.kind === kind ? "border-primary" : "border-transparent hover:border-border",
                      )}
                      title={kind === "none" ? "No effect" : "Blur background"}
                    >
                      {kind === "none" ? <Ban className="h-4 w-4" /> : <Droplets className="h-4 w-4" />}
                    </button>
                  ))}
                  {backgrounds.map((b) => (
                    <div key={b.id} className="group relative">
                      <button
                        type="button"
                        disabled={effectFailed}
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
                      disabled={effectFailed}
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
                  {effectFailed
                    ? "Background effects aren't available on this device."
                    : uploadError ??
                      "Done on this device, and images stay in this browser. The first time takes a moment to load."}
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
              disabled={permissionError || !selectedDeviceId}
            >
              Start Camera
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
