import { useRef, useEffect, useState, useCallback } from "react";
import { useAppContext, screenStreamsMap, webcamStreamsMap } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn, displayUserId } from "@/lib/utils";
import { ScreenFpsMenu } from "./voice/ScreenFpsMenu";
import { useScreenShareFps } from "@/hooks/useScreenShareFps";
import { ClipControls } from "./voice/ClipControls";
import { useIsMobile } from "@/hooks/use-mobile";
import { gridLayout, GRID_GAP } from "@chatter/core/voice/grid";
import { WEBCAM_HIGH_QUALITY_MIN_WIDTH } from "@/lib/webrtc";
import type { WebcamQuality } from "@/lib/webrtc";
import { Eye, LayoutGrid, Maximize2, Monitor, Video, X } from "lucide-react";

/** How often the grid re-reads who is speaking, for the ring round a tile. */
const GRID_SPEAKING_POLL_MS = 150;

/** The strip under a focused feed shows this many tiles, chosen by who spoke
 *  last. */
const STRIP_MAX_TILES = 5;
/** Strip tile height bounds, px. Below the minimum the strip scrolls instead;
 *  the maximum, and the share of the panel, keep the stream the main thing. */
const STRIP_MIN_TILE_H = 64;
const STRIP_MAX_TILE_H = 120;
const STRIP_MAX_PANEL_SHARE = 0.18;
/** The strip's gap, and the space between it and the stream, px. */
const STRIP_GAP = 12;
const STRIP_PAD = 8;


/** Header bar shown above the resizable panel group — always visible */
/** How long the overlay stays up after the last sign of life. */
const CONTROLS_IDLE_MS = 2500;

/** Below this a press is a tap rather than the start of a pan or a pinch. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;

/**
 * Fade the overlay out when nothing is happening, back in on any pointer
 * movement over the video.
 *
 * It refuses to hide while the bar is being used: with the pointer on it, with
 * focus inside it, or with one of its menus open. That last check is why it
 * looks at the DOM rather than tracking each menu — the FPS and clip menus
 * render their content in a portal, so neither the pointer nor focus is inside
 * the header while one is open, and the bar would otherwise fade out from
 * under a menu the user was reading.
 *
 * A touch screen has no pointer to move and none to rest on the bar, so the
 * fade there was one-way: the bar went after two and a half seconds and
 * nothing could bring it back, taking Close, the sharer switcher and
 * fullscreen with it. On touch a tap on the video toggles it instead, and
 * only a tap — a pan or a pinch leaves it alone.
 */
function useIdleFade(
  hostRef: React.RefObject<HTMLElement | null>,
  headerRef: React.RefObject<HTMLElement | null>,
) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => {
      const header = headerRef.current;
      if (!header) return false;
      return (
        header.matches(":hover") ||
        header.contains(document.activeElement) ||
        header.querySelector('[data-state="open"]') !== null
      );
    };

    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (inUse()) {
          settle();
          return;
        }
        setVisible(false);
      }, CONTROLS_IDLE_MS);
    };

    const wake = () => {
      setVisible(true);
      settle();
    };

    let downAt = 0;
    let downX = 0;
    let downY = 0;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        wake();
        return;
      }
      downAt = e.timeStamp;
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (e.timeStamp - downAt > TAP_MAX_MS || moved > TAP_SLOP_PX) return;
      // Revealed by a tap, it stays until another one: 2.5s is not long
      // enough to notice the bar and reach the button you wanted.
      clearTimeout(timer);
      setVisible((v) => !v);
    };

    wake();
    host.addEventListener("mousemove", wake);
    host.addEventListener("mouseenter", wake);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointerup", onPointerUp);
    return () => {
      clearTimeout(timer);
      host.removeEventListener("mousemove", wake);
      host.removeEventListener("mouseenter", wake);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerup", onPointerUp);
    };
  }, [hostRef, headerRef]);

  return visible;
}

export function ScreenShareHeader({
  containerRef,
  hostRef,
  isPiP,
  onTogglePiP,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The video area whose pointer activity keeps the bar awake. */
  hostRef: React.RefObject<HTMLDivElement | null>;
  isPiP?: boolean;
  onTogglePiP?: () => void;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const controlsVisible = useIdleFade(hostRef, headerRef);
  const isMobile = useIsMobile();
  // 28px squares are a mouse size. A thumb needs the best part of 40, which
  // the bar can afford because it floats over the video rather than above it.
  const ctrlBtn = isMobile
    ? "h-10 w-10 p-0 text-muted-foreground hover:text-foreground"
    : "h-7 w-7 p-0 text-muted-foreground hover:text-foreground";
  const iconPx = isMobile ? 18 : 14;
  const { state, dispatch } = useAppContext();
  const { screenFps } = useScreenShareFps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supportsPiP = (() => { try { return !!document.pictureInPictureEnabled; } catch { return false; } })();

  const sharers = state.activeScreenSharers;
  const hasContent = sharers.length > 0 || state.activeWebcamStreamers.length > 0;

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  }, [containerRef]);

  const closeViewer = useCallback(() => {
    dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: false } });
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [dispatch]);

  if (
    !state.screenViewerOpen ||
    !hasContent ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  return (
    <div
      ref={headerRef}
      className={cn(
        "absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-1.5",
        "bg-background/75 backdrop-blur-md border-b border-border/60",
        "transition-opacity duration-200",
        // Faded out it must not swallow clicks meant for the video.
        controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
        </span>
        <p className="text-sm font-semibold text-info truncate">
          {state.selectedScreenSharer
            ? state.selectedScreenSharer === state.userId
              ? "Your screen (preview)"
              : `${displayUserId(state.selectedScreenSharer)}'s screen`
            : "Screen Share"}
        </p>
        {state.isScreenSharing && (() => {
          const viewers = state.screenViewers[state.userId!] || [];
          if (viewers.length === 0) return (
            <span className="text-xs text-muted-foreground">No viewers</span>
          );
          if (viewers.length <= 3) return (
            <span className="text-xs text-info">
              {viewers.map(displayUserId).join(", ")}
            </span>
          );
          return (
            <span className="text-xs text-info">
              {viewers.length} viewers
            </span>
          );
        })()}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {sharers.length > 1 && (
          <div className="flex items-center gap-1 mr-2">
            {sharers.map((sharerId) => (
              <button
                key={sharerId}
                onClick={() =>
                  dispatch({
                    type: "SET_SCREEN_VIEWER",
                    payload: { sharer: sharerId },
                  })
                }
                className={cn(
                  "rounded text-xs font-medium transition-colors cursor-pointer",
                  isMobile ? "px-3 py-2.5" : "px-2 py-1",
                  sharerId === state.selectedScreenSharer
                    ? "bg-info text-background"
                    : "bg-info/20 text-info hover:bg-info/30"
                )}
              >
                {sharerId === state.userId ? "You" : displayUserId(sharerId)}
              </button>
            ))}
          </div>
        )}
        <ClipControls />
        {state.isScreenSharing && (
          <ScreenFpsMenu>
            <Button
              size="sm"
              variant="ghost"
              className={cn("px-2 text-xs font-medium text-muted-foreground hover:text-foreground", isMobile ? "h-10" : "h-7")}
              title="Screen share quality"
            >
              {screenFps} FPS
            </Button>
          </ScreenFpsMenu>
        )}
        {onTogglePiP && supportsPiP && (
          <Button
            size="sm"
            variant="ghost"
            className={ctrlBtn}
            onClick={onTogglePiP}
            title={isPiP ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
          >
            {isPiP ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={iconPx}
                height={iconPx}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <path d="M8 21h8M12 17v4" />
                <path d="M7 9l5 3-5 3V9z" fill="currentColor" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={iconPx}
                height={iconPx}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <rect x="12" y="9" width="8" height="6" rx="1" />
              </svg>
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className={ctrlBtn}
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={iconPx}
              height={iconPx}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={iconPx}
              height={iconPx}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={ctrlBtn}
          onClick={closeViewer}
          title="Close viewer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={iconPx}
            height={iconPx}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Button>
      </div>
    </div>
  );
}

/**
 * The thumbnail's buttons, over the stream while the chat has the area: back
 * to the streams, or stop watching. A click anywhere else on the video is
 * also the way back, since the thumbnail is too small to watch in for long.
 */
export function MiniViewerControls({
  onExpand,
  onClose,
}: {
  onExpand: () => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const btn = cn(
    "flex items-center justify-center rounded bg-black/60 text-white/80 hover:bg-black/80 hover:text-white cursor-pointer",
    isMobile ? "h-9 w-9" : "h-7 w-7",
  );
  return (
    <>
      <button
        className="absolute inset-0 cursor-pointer"
        onClick={onExpand}
        aria-label="Back to the streams"
      />
      <div className="absolute right-1.5 top-1.5 flex gap-1 transition-opacity can-hover:opacity-0 can-hover:group-hover:opacity-100">
        <button className={btn} onClick={onExpand} title="Back to the streams">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button className={btn} onClick={onClose} title="Stop watching">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </>
  );
}

/**
 * Video content. `compact` is the thumbnail over the chat: one feed, no
 * grid, strip, zoom or volume — the one being watched, or with nothing
 * picked the first screen, else the first camera.
 */
export function ScreenShareViewer({
  speakingUsersRef,
  compact = false,
}: {
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
  compact?: boolean;
} = {}) {
  const { state, dispatch } = useAppContext();
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const mainWebcamVideoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const thumbVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const webcamVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Grid tiles, keyed `screen:<user>` or `cam:<user>` — one person can be both.
  const gridVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [gridBox, setGridBox] = useState({ width: 0, height: 0 });
  // The focused layout's panel, measured to size the strip's tiles.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelBox, setPanelBox] = useState({ width: 0, height: 0 });
  // When each person last spoke, for picking who the strip shows. Stamped
  // as someone starts or stops, so it changes only when `speaking` does.
  const [lastSpoke, setLastSpoke] = useState<Map<string, number>>(() => new Map());
  const sampledSpeakingRef = useRef<Set<string>>(new Set());
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const [, setStreamVersion] = useState(0);

  // Per-sharer volume state (persists when switching between sharers)
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [screenMuted, setScreenMuted] = useState<Record<string, boolean>>({});

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  // Every pointer currently down on the video, so one finger can pan and two
  // can pinch. A mouse only ever puts one entry in here.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTapAt = useRef(0);

  // Reset zoom/pan when switching sharers, or shrinking to the thumbnail
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [state.selectedScreenSharer, compact]);

  // Clamp pan so the video edge can reach the container edge but not beyond.
  // The CSS applies: scale(z) translate(px/z %, py/z %).
  // At zoom z, the visible portion is 1/z of the total. To pan the edge
  // of the content to the edge of the viewport: max translate = (z-1)/z * 50%.
  // Since CSS divides by z: maxPan = (z-1) * 50.
  const clampPan = useCallback((px: number, py: number, z: number) => {
    if (z <= 1) return { x: 0, y: 0 };
    const maxPan = (z - 1) * 50;
    return {
      x: Math.max(-maxPan, Math.min(maxPan, px)),
      y: Math.max(-maxPan, Math.min(maxPan, py)),
    };
  }, []);

  const clampPanRef = useRef(clampPan);
  clampPanRef.current = clampPan;

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  // One set of handlers for mouse, pen and touch. Panning a zoomed image was
  // mouse-only before, and zooming was the scroll wheel — between them a phone
  // could neither zoom nor move around a screen share, which is where reading
  // someone's terminal actually needs it.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger cancels the pan it interrupted and starts a pinch.
      isDragging.current = false;
      pinch.current = { dist: spread(), zoom };
      return;
    }
    if (pointers.current.size > 2) return;
    if (zoom <= 1) return;
    // Capture rather than a mouseleave handler: the drag now survives the
    // pointer leaving the video, and ends wherever it is actually released.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    // Without this a drag across the video starts a native selection instead.
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    panStart.current = { ...pan };
  }, [zoom, pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const start = pinch.current;
      if (start.dist <= 0) return;
      const next = Math.max(1, Math.min(10, (start.zoom * spread()) / start.dist));
      setZoom(next);
      setPan((prev) =>
        next <= 1 ? { x: 0, y: 0 } : clampPanRef.current(prev.x, prev.y, next),
      );
      return;
    }

    if (!isDragging.current || !videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStart.current.x) / rect.width) * 100;
    const dy = ((e.clientY - dragStart.current.y) / rect.height) * 100;
    setPan(clampPan(panStart.current.x + dx, panStart.current.y + dy, zoom));
  }, [zoom, clampPan]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const down = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) isDragging.current = false;

    // Double-tap to reset, the touch counterpart of the double-click below.
    // `dblclick` is synthesised inconsistently on mobile browsers, so it is
    // measured here rather than relied on.
    if (e.pointerType === "mouse" || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > TAP_SLOP_PX) return;
    const now = e.timeStamp;
    if (now - lastTapAt.current < 300) {
      resetZoom();
      lastTapAt.current = 0;
    } else {
      lastTapAt.current = now;
    }
  }, [resetZoom]);

  const sharers = state.activeScreenSharers;
  const webcamStreamers = state.activeWebcamStreamers;

  // A camera that has since gone off is no longer a choice, so it counts as
  // none — it used to leave the viewer on "Connecting" for a feed that was gone.
  const currentWebcamStreamer =
    state.selectedWebcamStreamer && webcamStreamers.includes(state.selectedWebcamStreamer)
      ? state.selectedWebcamStreamer
      : null;
  // The thumbnail has no grid to fall back on, so with nothing picked it
  // shows the first screen; with no screens, the first camera follows below.
  const currentSharer =
    state.selectedScreenSharer ??
    (compact && !currentWebcamStreamer ? sharers[0] ?? null : null);
  const feedCount = sharers.length + webcamStreamers.length;
  // Everyone at once until someone is picked: a call with cameras on is about
  // the people, and one big face with the rest in a strip is a screen share's
  // layout. Picking a feed focuses it; the strip's Grid button comes back.
  const gridMode = !compact && feedCount >= 2 && !currentSharer && !currentWebcamStreamer;
  const layout = gridLayout(feedCount, gridBox.width, gridBox.height);
  // A webcam is focused in the main view when explicitly selected, or when
  // there are no screen sharers at all.
  const focusedWebcam = currentWebcamStreamer
    ?? (sharers.length === 0 && webcamStreamers.length > 0 ? webcamStreamers[0] : null);
  const showingWebcam = focusedWebcam !== null && (currentWebcamStreamer !== null || !currentSharer);
  const isSelfSharer = currentSharer === state.userId;
  const isSelfWebcam = focusedWebcam === state.userId;
  const currentVolume = currentSharer ? (screenVolumes[currentSharer] ?? 50) : 50;
  const currentMuted = currentSharer ? (screenMuted[currentSharer] ?? false) : false;

  // Listen for stream updates from VoiceControls
  useEffect(() => {
    const handler = () => setStreamVersion((v) => v + 1);
    window.addEventListener("screen-stream-update", handler);
    window.addEventListener("webcam-stream-update", handler);
    return () => {
      window.removeEventListener("screen-stream-update", handler);
      window.removeEventListener("webcam-stream-update", handler);
    };
  }, []);

  // Attach streams to video elements and apply volume
  useEffect(() => {
    if (currentSharer && mainVideoRef.current) {
      const stream = screenStreamsMap.get(currentSharer);
      if (stream && mainVideoRef.current.srcObject !== stream) {
        mainVideoRef.current.srcObject = stream;
        mainVideoRef.current.play().catch(() => {});
      }
      mainVideoRef.current.muted = isSelfSharer;
      mainVideoRef.current.volume = (isSelfSharer || currentMuted) ? 0 : currentVolume / 100;
    }
    if (focusedWebcam && mainWebcamVideoRef.current) {
      const stream = webcamStreamsMap.get(focusedWebcam);
      if (stream && mainWebcamVideoRef.current.srcObject !== stream) {
        mainWebcamVideoRef.current.srcObject = stream;
        mainWebcamVideoRef.current.play().catch(() => {});
      }
      mainWebcamVideoRef.current.muted = isSelfWebcam;
    }
    // Screen share thumbnails
    screenStreamsMap.forEach((stream, sharerId) => {
      const el = thumbVideoRefs.current.get(sharerId);
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    });
    // Webcam thumbnails
    webcamStreamsMap.forEach((stream, userId) => {
      const el = webcamVideoRefs.current.get(userId);
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    });
    // Grid tiles. A screen tile carries the share's sound — in the grid it is
    // the only element playing it — at the volume set for that sharer.
    gridVideoRefs.current.forEach((el, key) => {
      const sep = key.indexOf(":");
      const kind = key.slice(0, sep);
      const userId = key.slice(sep + 1);
      const stream = (kind === "screen" ? screenStreamsMap : webcamStreamsMap).get(userId);
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
      if (kind === "screen") {
        el.muted = userId === state.userId;
        el.volume = screenMuted[userId] ? 0 : (screenVolumes[userId] ?? 50) / 100;
      }
    });
  });

  // Each camera is asked for at the size it is drawn: the full picture for
  // the one in focus or a big grid tile, the small copy for a thumbnail or a
  // small tile. Only changes are sent.
  const sentQualityRef = useRef<Map<string, WebcamQuality>>(new Map());
  useEffect(() => {
    // An unmeasured grid has no tile size yet; asking now would only be
    // taken back a frame later.
    if (gridMode && gridBox.width === 0) return;
    for (const userId of webcamStreamers) {
      if (userId === state.userId) continue;
      // The thumbnail is narrower than the small copy is wide.
      const quality: WebcamQuality = compact
        ? "low"
        : gridMode
        ? layout.tileWidth >= WEBCAM_HIGH_QUALITY_MIN_WIDTH ? "high" : "low"
        : showingWebcam && userId === focusedWebcam ? "high" : "low";
      if (sentQualityRef.current.get(userId) === quality) continue;
      sentQualityRef.current.set(userId, quality);
      window.dispatchEvent(
        new CustomEvent("webcam-quality", { detail: { sharerId: userId, quality } }),
      );
    }
  }, [compact, gridMode, gridBox.width, layout.tileWidth, webcamStreamers, showingWebcam, focusedWebcam, state.userId]);

  // The grid is sized to the space it is given, which a resizable panel and a
  // phone's rotation both change under it.
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!gridMode || !el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGridBox((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridMode]);

  // Who is speaking lives in a ref the call updates many times a second; the
  // grid and the strip's people sample it rather than re-rendering on every
  // level change.
  useEffect(() => {
    if (compact || !speakingUsersRef) return;
    const id = setInterval(() => {
      const next = speakingUsersRef.current;
      const prev = sampledSpeakingRef.current;
      if (prev.size === next.size && [...next].every((u) => prev.has(u))) return;
      const sample = new Set(next);
      sampledSpeakingRef.current = sample;
      setSpeaking(sample);
      const now = Date.now();
      setLastSpoke((stamps) => {
        const out = new Map(stamps);
        for (const userId of [...prev, ...sample]) out.set(userId, now);
        return out;
      });
    }, GRID_SPEAKING_POLL_MS);
    return () => clearInterval(id);
  }, [compact, speakingUsersRef]);

  const setVolume = useCallback((vol: number) => {
    if (!currentSharer) return;
    setScreenVolumes((prev) => ({ ...prev, [currentSharer]: vol }));
    if (mainVideoRef.current) {
      mainVideoRef.current.volume = currentMuted ? 0 : vol / 100;
    }
  }, [currentSharer, currentMuted]);

  const toggleMute = useCallback(() => {
    if (!currentSharer) return;
    const newMuted = !currentMuted;
    setScreenMuted((prev) => ({ ...prev, [currentSharer]: newMuted }));
    if (mainVideoRef.current) {
      mainVideoRef.current.volume = newMuted ? 0 : currentVolume / 100;
    }
  }, [currentSharer, currentMuted, currentVolume]);

  // Wheel zoom — non-passive listener, attached after the DOM renders
  const viewerVisible = state.screenViewerOpen && (sharers.length > 0 || webcamStreamers.length > 0) && state.inVoiceChannel;
  useEffect(() => {
    const container = videoContainerRef.current;
    if (!viewerVisible || compact || !container) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setZoom((prevZoom) => {
        const delta = e.deltaY > 0 ? -0.2 : 0.2;
        const newZoom = Math.max(1, Math.min(10, prevZoom + delta * prevZoom * 0.3));
        if (newZoom <= 1) {
          setPan({ x: 0, y: 0 });
        } else {
          setPan((prev) => clampPanRef.current(prev.x, prev.y, newZoom));
        }
        return newZoom;
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
    // The grid has no zoom and unmounts the container; leaving it mounts a new one.
  }, [viewerVisible, gridMode, compact]);

  useEffect(() => {
    const el = panelRef.current;
    if (!viewerVisible || compact || gridMode || !el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPanelBox((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewerVisible, compact, gridMode]);

  if (
    !state.screenViewerOpen ||
    (sharers.length === 0 && webcamStreamers.length === 0) ||
    !state.inVoiceChannel
  ) {
    return null;
  }

  const voiceMembers = state.voiceChannelId
    ? state.voiceChannelMembers[state.voiceChannelId] ?? []
    : [];

  const nameOf = (userId: string) =>
    userId === state.userId
      ? "You"
      : state.userPresence[userId]?.displayName || displayUserId(userId);

  if (gridMode) {
    const tiles = [
      ...sharers.map((userId) => ({ kind: "screen" as const, userId })),
      ...webcamStreamers.map((userId) => ({ kind: "cam" as const, userId })),
    ];
    return (
      <div className="flex flex-col min-h-0 h-full bg-black/95">
        <div
          ref={gridContainerRef}
          className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden"
        >
          <div
            className="flex flex-wrap justify-center"
            style={{
              gap: GRID_GAP,
              // Exactly `cols` tiles fit on a line, so the wrap makes the rows
              // and a short last row sits centred under the others.
              width: layout.cols * layout.tileWidth + (layout.cols - 1) * GRID_GAP,
            }}
          >
            {tiles.map(({ kind, userId }) => {
              const key = `${kind}:${userId}`;
              const stream = (kind === "screen" ? screenStreamsMap : webcamStreamsMap).get(userId);
              const isSpeaking = kind === "cam" && speaking.has(userId);
              return (
                <button
                  key={key}
                  className={cn(
                    "relative overflow-hidden rounded-xl border-2 bg-neutral-900 cursor-pointer transition-colors",
                    isSpeaking ? "border-success" : "border-transparent hover:border-white/30",
                  )}
                  style={{ width: layout.tileWidth, height: layout.tileHeight }}
                  onClick={() =>
                    dispatch({
                      type: "SET_SCREEN_VIEWER",
                      payload: kind === "screen" ? { sharer: userId } : { webcamStreamer: userId },
                    })
                  }
                  title={`Focus ${nameOf(userId) === "You" ? "your" : `${nameOf(userId)}'s`} ${kind === "screen" ? "screen" : "camera"}`}
                >
                  {stream ? (
                    <video
                      ref={(el) => {
                        if (el) gridVideoRefs.current.set(key, el);
                        else gridVideoRefs.current.delete(key);
                      }}
                      autoPlay
                      playsInline
                      muted={kind === "cam" || userId === state.userId}
                      className={cn(
                        "w-full h-full select-none",
                        kind === "cam" ? "object-cover" : "object-contain",
                      )}
                      draggable={false}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-white/50">
                      Connecting…
                    </div>
                  )}
                  <div className="absolute bottom-2 left-2 flex max-w-[85%] items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
                    {kind === "screen" ? (
                      <Monitor className="h-3 w-3 shrink-0 text-info" />
                    ) : (
                      <Video className="h-3 w-3 shrink-0 text-info" />
                    )}
                    <span className="truncate">{nameOf(userId)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={compact ? undefined : panelRef}
      className="flex flex-col min-h-0 h-full bg-black/95"
      style={compact ? undefined : { gap: STRIP_GAP }}
    >
      {/* Main video. It has every pixel above the strip, which sits on the
          panel's bottom edge, and is centred in them — Discord's layout. */}
      <div
        ref={videoContainerRef}
        className={cn(
          "flex-1 flex items-center justify-center bg-black min-h-0 relative group overflow-hidden",
          // `active:` rather than the drag flag: that lives in a ref, which
          // never re-renders, so the grabbing cursor never actually appeared.
          zoom > 1 && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={resetZoom}
        // The browser must not claim the gesture for scrolling or its own
        // pinch-zoom — nothing here scrolls, and the pinch is ours.
        style={{ touchAction: "none" }}
      >
        {showingWebcam && focusedWebcam && webcamStreamsMap.has(focusedWebcam) ? (
          <div className="w-full h-full flex items-center justify-center">
            <video
              ref={mainWebcamVideoRef}
              autoPlay
              playsInline
              className="object-contain w-full h-full bg-black select-none"
              draggable={false}
            />
          </div>
        ) : currentSharer && screenStreamsMap.has(currentSharer) ? (
          <div
            className="w-full h-full"
            style={{
              transform: zoom > 1
                ? `scale(${zoom}) translate(${pan.x / zoom}%, ${pan.y / zoom}%)`
                : undefined,
              transformOrigin: "center center",
              willChange: zoom > 1 ? "transform" : undefined,
            }}
          >
            <video
              ref={mainVideoRef}
              autoPlay
              playsInline
              className="object-contain w-full h-full bg-black select-none"
              draggable={false}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mb-2 opacity-50"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <p className="text-sm">Connecting to stream…</p>
          </div>
        )}

      {/* The thumbnail's viewer count — a screen's only: a camera is someone
          in the call, not a broadcast with an audience. */}
      {compact && !showingWebcam && currentSharer && screenStreamsMap.has(currentSharer) && (
        <div
          className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-xs tabular-nums text-white/80"
          title="Watching"
        >
          <Eye className="h-3 w-3" />
          {(state.screenViewers[currentSharer] ?? []).filter((v) => v !== currentSharer).length}
        </div>
      )}

      {/* Zoom indicator */}
      {zoom > 1 && (
        <div className="absolute left-3 bottom-3 flex items-center gap-1.5 px-2 py-1 bg-black/60 rounded-lg text-xs text-white/80">
          <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            className="text-white/60 hover:text-white cursor-pointer"
            onClick={resetZoom}
            title="Reset zoom (or double-tap)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Volume controls overlay */}
      {!compact && state.selectedScreenSharer &&
        screenStreamsMap.has(state.selectedScreenSharer) && (
        <div className="absolute right-3 bottom-3 flex flex-col items-center gap-2 px-2 py-2.5 bg-black/60 rounded-lg can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity">
          <span className="text-xs text-white/60 tabular-nums">
            {currentMuted ? 0 : currentVolume}%
          </span>
          <Slider
            value={[currentMuted ? 0 : currentVolume]}
            onValueChange={([v]) => setVolume(v)}
            max={100}
            step={1}
            orientation="vertical"
            style={{ height: '5rem', minHeight: '5rem' }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-white/80 hover:text-white shrink-0"
            onClick={toggleMute}
            title={currentMuted ? "Unmute" : "Mute"}
          >
            {currentMuted || currentVolume === 0 ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            )}
          </Button>
        </div>
      )}
      </div>

      {!compact && (() => {
        // Every other feed, then everyone in the call. The strip shows the
        // STRIP_MAX_TILES whose owners spoke last — feeds first while nobody
        // has — in this order, so a tile does not hop along the row each
        // time someone talks.
        type StripTile = { kind: "screen" | "cam" | "member"; userId: string; muted?: boolean };
        const all: StripTile[] = [
          ...sharers
            .filter((id) => showingWebcam || id !== currentSharer)
            .map((userId) => ({ kind: "screen" as const, userId })),
          ...webcamStreamers
            .filter((id) => !showingWebcam || id !== focusedWebcam)
            .map((userId) => ({ kind: "cam" as const, userId })),
          ...voiceMembers.map((m) => ({ kind: "member" as const, userId: m.userId, muted: m.muted })),
        ];
        const spokeAt = (t: StripTile) => lastSpoke.get(t.userId) ?? 0;
        const picked = new Set(
          all
            .map((t, i) => ({ t, i }))
            .sort((a, b) => spokeAt(b.t) - spokeAt(a.t) || a.i - b.i)
            .slice(0, STRIP_MAX_TILES)
            .map(({ t }) => t),
        );
        const tiles = all.filter((t) => picked.has(t));
        const hasGrid = feedCount > 1;

        // Tiles are 16:9, as wide as an even share of the row up to a cap
        // that keeps them thumbnails. The Grid button is a square of the
        // same height.
        const slots = tiles.length + (hasGrid ? 1 : 0);
        const rowWidth = panelBox.width - 2 * STRIP_PAD - STRIP_GAP * Math.max(0, slots - 1);
        const byWidth = rowWidth / (tiles.length * (16 / 9) + (hasGrid ? 1 : 0));
        const tileH = Math.floor(
          Math.max(STRIP_MIN_TILE_H, Math.min(byWidth, STRIP_MAX_TILE_H, panelBox.height * STRIP_MAX_PANEL_SHARE)),
        );
        const tileW = Math.floor((tileH * 16) / 9);
        const box = { width: tileW, height: tileH };
        const label = "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-0.5 flex items-center gap-1";

        return (
          // Centred by the inner row's margins rather than justify-center,
          // which would push the first tiles out of reach of the scroll.
          <div className="overflow-x-auto shrink-0" style={{ padding: `0 ${STRIP_PAD}px ${STRIP_PAD}px` }}>
          <div className="flex w-max mx-auto" style={{ gap: STRIP_GAP }}>
            {hasGrid && (
              <button
                className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-border/50 bg-black text-white/70 transition-all hover:border-white/40 hover:text-white cursor-pointer"
                style={{ width: tileH, height: tileH }}
                onClick={() => dispatch({ type: "SET_SCREEN_VIEWER", payload: { sharer: null } })}
                title="Show everyone"
              >
                <LayoutGrid className="h-5 w-5" />
                <span className="text-xs font-semibold">Grid</span>
              </button>
            )}
            {tiles.map((tile) => {
              const { kind, userId } = tile;
              if (kind === "screen") {
                return (
                  <button
                    key={`screen-${userId}`}
                    className="relative shrink-0 rounded-lg border-2 border-border/50 overflow-hidden bg-black cursor-pointer transition-all hover:border-info/50 opacity-80 hover:opacity-100"
                    style={box}
                    onClick={() => dispatch({ type: "SET_SCREEN_VIEWER", payload: { sharer: userId } })}
                    title={`Watch ${nameOf(userId) === "You" ? "your" : `${nameOf(userId)}'s`} screen`}
                  >
                    <video
                      ref={(el) => {
                        if (el) thumbVideoRefs.current.set(userId, el);
                        else thumbVideoRefs.current.delete(userId);
                      }}
                      autoPlay playsInline muted
                      className="w-full h-full object-contain"
                    />
                    <div className={label}>
                      <Monitor className="h-3 w-3 shrink-0 text-info" />
                      <p className="text-xs text-white font-medium truncate">{nameOf(userId)}</p>
                    </div>
                  </button>
                );
              }
              if (kind === "cam") {
                return (
                  <button
                    key={`webcam-${userId}`}
                    className="relative shrink-0 rounded-lg border-2 border-border/50 overflow-hidden bg-black cursor-pointer transition-all hover:border-info/50 opacity-80 hover:opacity-100"
                    style={box}
                    onClick={() => dispatch({ type: "SET_SCREEN_VIEWER", payload: { webcamStreamer: userId } })}
                    title={`Watch ${nameOf(userId) === "You" ? "your" : `${nameOf(userId)}'s`} camera`}
                  >
                    {webcamStreamsMap.has(userId) ? (
                      <video
                        ref={(el) => {
                          if (el) webcamVideoRefs.current.set(userId, el);
                          else webcamVideoRefs.current.delete(userId);
                        }}
                        autoPlay playsInline muted={userId === state.userId}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Video className="h-6 w-6 text-info/50" />
                      </div>
                    )}
                    <div className={label}>
                      <Video className="h-3 w-3 shrink-0 text-info" />
                      <p className="text-xs text-white font-medium truncate">{nameOf(userId)}</p>
                    </div>
                  </button>
                );
              }
              const initial =
                (state.userPresence[userId]?.displayName || displayUserId(userId))[0]?.toUpperCase() || "?";
              const isSpeaking = speaking.has(userId) && !tile.muted;
              return (
                <div
                  key={`member-${userId}`}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-lg border-2 bg-neutral-800 transition-colors",
                    isSpeaking ? "border-success" : "border-transparent",
                  )}
                  style={box}
                  title={nameOf(userId)}
                >
                  <span className="font-semibold text-white/90 select-none" style={{ fontSize: tileH * 0.45 }}>
                    {initial}
                  </span>
                </div>
              );
            })}
          </div>
          </div>
        );
      })()}
    </div>
  );
}
