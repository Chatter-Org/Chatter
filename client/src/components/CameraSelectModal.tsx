import { useState, useEffect, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BlurredCamera } from "@/lib/backgroundBlur";

interface CameraSelectModalProps {
  open: boolean;
  onClose: () => void;
  onStart: (deviceId: string, fps: 30 | 60, blur: boolean) => void;
}

const FPS_OPTIONS: Array<30 | 60> = [30, 60];

/** This device's last choice. A convenience only, so a storage that throws
 *  (private windows, blocked site data) just means starting from off. */
const BLUR_STORAGE_KEY = "chatter_camera_blur";

function readBlurChoice(): boolean {
  try {
    return localStorage.getItem(BLUR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveBlurChoice(on: boolean) {
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

export function CameraSelectModal({ open, onClose, onStart }: CameraSelectModalProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [fps, setFps] = useState<30 | 60>(30);
  // null while unknown — browsers that do not report track capabilities get
  // both options rather than a silently missing one.
  const [maxDeviceFps, setMaxDeviceFps] = useState<number | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const [blur, setBlur] = useState(readBlurChoice);
  // The preview through the blur, so what you see is what the call will see.
  const [blurredPreview, setBlurredPreview] = useState<BlurredCamera | null>(null);
  const [blurFailed, setBlurFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

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

  // Run the preview through the blur while it is on. It blurs a clone, so
  // turning blur off (which stops what it was given) leaves the preview going.
  useEffect(() => {
    const source = blur ? previewStream?.getVideoTracks()[0] : undefined;
    if (!source) return;
    let cancelled = false;
    let blurred: BlurredCamera | null = null;
    const clone = source.clone();
    import("@/lib/backgroundBlur")
      .then(({ blurBackground }) => blurBackground(clone, 30))
      .then((b) => {
        if (cancelled) {
          b.stop();
          return;
        }
        blurred = b;
        setBlurFailed(false);
        setBlurredPreview(b);
      })
      .catch((err) => {
        console.warn("[camera] background blur unavailable:", err);
        clone.stop();
        if (!cancelled) setBlurFailed(true);
      });
    return () => {
      cancelled = true;
      blurred?.stop();
      setBlurredPreview(null);
    };
  }, [blur, previewStream]);

  const blurredStream = useMemo(
    () => (blurredPreview ? new MediaStream([blurredPreview.track]) : null),
    [blurredPreview],
  );
  // While blur loads there is nothing to show rather than the unblurred
  // camera — it is on precisely because the room behind is not for sharing.
  const shownStream = blur && !blurFailed ? blurredStream : previewStream;

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

  function handleStart() {
    stopPreview();
    saveBlurChoice(blur);
    // Blurring every frame twice as often is more than most machines can
    // keep up with, so blur sends at 30.
    onStart(selectedDeviceId, supports60 && !blur ? fps : 30, blur && !blurFailed);
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
                    const disabled = option === 60 && (!supports60 || blur);
                    return (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={(fps === option || blur) && !disabled ? "default" : "outline"}
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
                    : blur
                      ? "Background blur sends at 30 FPS."
                      : "60 FPS is smoother but uses more bandwidth."}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label htmlFor="camera-blur">Blur background</Label>
                  <p className="text-xs text-muted-foreground">
                    {blurFailed
                      ? "Background blur isn't available on this device."
                      : "Done on this device; the first time takes a moment to load."}
                  </p>
                </div>
                <Switch
                  id="camera-blur"
                  checked={blur && !blurFailed}
                  disabled={blurFailed}
                  onCheckedChange={setBlur}
                />
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
                      : previewStream && blur && !blurFailed
                        ? "Loading background blur..."
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
