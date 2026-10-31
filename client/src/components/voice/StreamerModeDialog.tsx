import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useAppContext, screenStreamsMap } from "@/lib/store";
import { useStreamerMode } from "@/hooks/useStreamerMode";
import { avatarStore, type StoredAvatar } from "@/lib/avatarStore";
import {
  AVATAR_ZOOM,
  readAvatarArms,
  readAvatarZoom,
  saveAvatarArms,
  saveAvatarZoom,
} from "@/lib/cameraBackgrounds";
import {
  STREAMER_MODE_CHANGE_EVENT,
  STREAMER_SIZE,
  streamerAvatarId,
  streamerModeSupported,
  type StreamerPlacement,
} from "@/lib/streamerMode";
import { Plus, UserRound } from "lucide-react";

interface StreamerModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SELECT =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

/** How far an arrow key moves the avatar, as a share of the room to move in. */
const KEY_STEP = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Streamer mode's settings: on or off, which avatar and camera, and where the
 * avatar sits on the share and how big. The preview is a stand-in screen, or
 * your own share while you are sharing; the avatar is dragged about on it.
 * Everything but on and off reaches a share in progress straight away.
 */
export function StreamerModeDialog({ open, onOpenChange }: StreamerModeDialogProps) {
  const { state } = useAppContext();
  const { streamer, setStreamer } = useStreamerMode();
  const supported = streamerModeSupported();
  const [avatars, setAvatars] = useState<StoredAvatar[] | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const avatarId = streamerAvatarId(streamer);
  // A move of the slider, until another avatar is chosen; else its saved zoom.
  const [zoomed, setZoomed] = useState<{ id: string; zoom: number } | null>(null);
  const zoom =
    zoomed && zoomed.id === avatarId ? zoomed.zoom : avatarId ? readAvatarZoom(avatarId) : AVATAR_ZOOM.default;
  const [arms, setArms] = useState(readAvatarArms);
  // Bumped as the streams change, to read your own share again.
  const [, setStreamsChanged] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const { placement } = streamer;

  useEffect(() => {
    if (!open || !avatarStore) return;
    const store = avatarStore;
    let cancelled = false;
    const refresh = () =>
      store
        .list()
        .then((list) => !cancelled && setAvatars(list))
        .catch(() => !cancelled && setAvatars([]));
    void refresh();
    const unsubscribe = store.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setCameras(all.filter((d) => d.kind === "videoinput")))
      .catch(() => setCameras([]));
  }, [open]);

  // Your own share behind the avatar while there is one, so where it goes is
  // where it is.
  const ownShare =
    open && state.isScreenSharing && state.userId ? (screenStreamsMap.get(state.userId) ?? null) : null;
  useEffect(() => {
    if (!open) return;
    const update = () => setStreamsChanged((n) => n + 1);
    window.addEventListener("screen-stream-update", update);
    return () => window.removeEventListener("screen-stream-update", update);
  }, [open]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = ownShare;
    if (ownShare) video.play().catch(() => {});
  }, [ownShare]);

  const place = (next: Partial<StreamerPlacement>) =>
    setStreamer({ ...streamer, placement: { ...placement, ...next } });

  function moveTo(clientX: number, clientY: number) {
    const area = previewRef.current?.getBoundingClientRect();
    const drag = dragRef.current;
    if (!area || !drag) return;
    const side = Math.min(area.width, area.height * placement.size);
    const roomX = area.width - side;
    const roomY = area.height - side;
    place({
      x: roomX > 0 ? clamp01((clientX - area.left - drag.dx) / roomX) : 0,
      y: roomY > 0 ? clamp01((clientY - area.top - drag.dy) / roomY) : 0,
    });
  }

  async function handleAddAvatar() {
    if (!avatarStore) return;
    setAvatarError(null);
    try {
      const added = await avatarStore.add();
      if (added.length === 0) return;
      setAvatars(await avatarStore.list());
      setStreamer({ ...streamer, avatarId: added[0].id });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "That avatar couldn't be added.");
    }
  }

  // The preview is 16:9, so the avatar's side of the height is this much of
  // the width.
  const sideOfWidth = placement.size * (9 / 16) * 100;
  const sideOfHeight = placement.size * 100;
  const knownAvatar = avatars?.some((a) => a.id === avatarId) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Streamer mode</DialogTitle>
          <DialogDescription>
            Your camera avatar on your screen share. The camera only follows your face; its picture stays on this device.
          </DialogDescription>
        </DialogHeader>

        {!supported ? (
          <p className="text-sm text-muted-foreground">
            Streamer mode needs Chrome, Edge or the Chatter desktop app.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="streamer-on" className="text-sm font-medium">
                Put my avatar on my screen share
                <span className="block text-xs font-normal text-muted-foreground">
                  {state.isScreenSharing
                    ? "Turning it on or off takes effect the next time you share."
                    : "Takes effect when you next share your screen."}
                </span>
              </label>
              <Switch
                id="streamer-on"
                checked={streamer.on}
                disabled={!avatarId}
                onCheckedChange={(on) => setStreamer({ ...streamer, on })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Avatar</label>
              <div className="flex gap-2">
                <select
                  className={SELECT}
                  value={knownAvatar ? (avatarId ?? "") : ""}
                  onChange={(e) => setStreamer({ ...streamer, avatarId: e.target.value || null })}
                >
                  {!knownAvatar && <option value="">{avatars?.length ? "Choose an avatar" : "No avatars yet"}</option>}
                  {(avatars ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleAddAvatar()}
                  className="flex shrink-0 items-center justify-center rounded-md border px-2 text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Add a VRM avatar"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {avatarError && <p className="text-xs text-destructive">{avatarError}</p>}
            </div>

            {cameras.length > 1 && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Camera</label>
                <select
                  className={SELECT}
                  value={streamer.deviceId ?? ""}
                  onChange={(e) => setStreamer({ ...streamer, deviceId: e.target.value || null })}
                >
                  <option value="">Default camera</option>
                  {cameras.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Position — drag the avatar</label>
              <div
                ref={previewRef}
                className="relative aspect-video overflow-hidden rounded-lg bg-muted"
              >
                {ownShare ? (
                  <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-fill" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                    Your screen
                  </div>
                )}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="Avatar position"
                  aria-valuetext={`${Math.round(placement.x * 100)}% across, ${Math.round(placement.y * 100)}% down`}
                  className="absolute flex touch-none items-center justify-center rounded-md border-2 border-primary bg-primary/10 text-primary cursor-grab active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    width: `${sideOfWidth}%`,
                    height: `${sideOfHeight}%`,
                    left: `calc((100% - ${sideOfWidth}%) * ${placement.x})`,
                    top: `calc((100% - ${sideOfHeight}%) * ${placement.y})`,
                  }}
                  onPointerDown={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
                  }}
                  onPointerMove={(e) => moveTo(e.clientX, e.clientY)}
                  onPointerUp={() => (dragRef.current = null)}
                  onPointerCancel={() => (dragRef.current = null)}
                  onKeyDown={(e) => {
                    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
                    if (!step) return;
                    e.preventDefault();
                    place({
                      x: clamp01(placement.x + step[0] * KEY_STEP),
                      y: clamp01(placement.y + step[1] * KEY_STEP),
                    });
                  }}
                >
                  {!ownShare && <UserRound className="h-1/2 w-1/2" />}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="w-10 text-xs font-medium text-muted-foreground">Size</label>
              <Slider
                min={STREAMER_SIZE.min}
                max={STREAMER_SIZE.max}
                step={0.01}
                value={[placement.size]}
                onValueChange={([size]) => place({ size })}
                className="flex-1"
                aria-label="Avatar size"
              />
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(placement.size * 100)}%
              </span>
            </div>

            {avatarId && (
              <div className="flex items-center gap-3">
                <label className="w-10 text-xs font-medium text-muted-foreground">Zoom</label>
                <Slider
                  min={AVATAR_ZOOM.min}
                  max={AVATAR_ZOOM.max}
                  step={0.05}
                  value={[zoom]}
                  onValueChange={([next]) => {
                    setZoomed({ id: avatarId, zoom: next });
                    // Shared with the camera picker's, and reaches the share
                    // through the same event as a move.
                    saveAvatarZoom(avatarId, next);
                    window.dispatchEvent(new CustomEvent(STREAMER_MODE_CHANGE_EVENT));
                  }}
                  className="flex-1"
                  aria-label="Avatar zoom"
                />
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="streamer-arms" className="text-xs font-medium text-muted-foreground">
                Track arms
                <span className="block font-normal">Uses more CPU; arms rest when off or out of view.</span>
              </label>
              <Switch
                id="streamer-arms"
                checked={arms}
                onCheckedChange={(on) => {
                  setArms(on);
                  saveAvatarArms(on);
                  window.dispatchEvent(new CustomEvent(STREAMER_MODE_CHANGE_EVENT));
                }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
