import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { FileAttachmentCard } from "@/components/FileAttachmentCard";
import { cn } from "@/lib/utils";
import { getVoiceSettings } from "@chatter/core/voice/settings";
import { formatVoiceTime, waveformPeaks } from "@chatter/core/voiceMessage";

const BARS = 48;

interface Loaded {
  blob: Blob;
  peaks: number[];
  /** From the decoded samples: a recording straight from MediaRecorder can
   *  report no duration of its own, and the timeline cannot wait for it. */
  duration: number;
}

// Kept per URL so a message scrolled away and back is not fetched and decoded
// again. Voice messages are small; the cap only stops a long session growing
// without bound.
const cache = new Map<string, Promise<Loaded>>();
const CACHE_LIMIT = 100;

const MIME_BY_EXT: Record<string, string> = { weba: "audio/webm", oga: "audio/ogg", m4a: "audio/mp4" };

function load(url: string): Promise<Loaded> {
  const hit = cache.get(url);
  if (hit) return hit;
  const promise = (async () => {
    // The media_session cookie goes with it, as it does for <audio>.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
    const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] ?? "audio/*" });
    try {
      // An offline context decodes without the click an AudioContext would
      // want before it starts.
      const ctx = new OfflineAudioContext(1, 1, 48000);
      const audio = await ctx.decodeAudioData(bytes.slice(0));
      return { blob, peaks: waveformPeaks(audio.getChannelData(0), BARS), duration: audio.duration };
    } catch {
      // Still playable by the element even if this browser will not decode
      // it here; it just goes without a shape.
      return { blob, peaks: waveformPeaks([], BARS), duration: 0 };
    }
  })();
  cache.set(url, promise);
  promise.catch(() => cache.delete(url));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return promise;
}

// One voice message at a time: starting one pauses whichever was playing.
let playing: HTMLAudioElement | null = null;

/**
 * A voice message in the timeline, a forum comment or a thread: play/pause,
 * the recording's waveform as the timeline (click or drag it to seek), the
 * time, and volume with mute.
 */
export function VoiceMessagePlayer({ url }: { url: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Fetched once it is near the screen, not when a page of history mounts.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    load(url)
      .then((result) => {
        if (cancelled) return;
        setLoaded(result);
        setDuration(result.duration);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url, visible]);

  // The element plays the fetched bytes, so playing and seeking never go back
  // to the server.
  useEffect(() => {
    if (!loaded) return;
    const src = URL.createObjectURL(loaded.blob);
    const audio = new Audio(src);
    audio.preload = "auto";
    const sinkId = getVoiceSettings().outputDeviceId;
    const sinkable = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId !== "default" && sinkable.setSinkId) sinkable.setSinkId(sinkId).catch(() => {});
    audioRef.current = audio;

    let frame = 0;
    const tick = () => {
      setCurrent(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      setIsPlaying(true);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setIsPlaying(false);
      cancelAnimationFrame(frame);
      setCurrent(audio.currentTime);
    };
    const onEnded = () => {
      onPause();
      audio.currentTime = 0;
      setCurrent(0);
    };
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration((d) => d || audio.duration);
      }
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    return () => {
      cancelAnimationFrame(frame);
      audio.pause();
      if (playing === audio) playing = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(src);
      audioRef.current = null;
    };
  }, [loaded]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted, loaded]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, []);

  const seekTo = useCallback(
    (clientX: number, target: HTMLElement) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = target.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      audio.currentTime = frac * duration;
      setCurrent(audio.currentTime);
    },
    [duration],
  );

  const onSeekKey = (e: React.KeyboardEvent) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
    if (!step) return;
    e.preventDefault();
    audio.currentTime = Math.min(duration, Math.max(0, audio.currentTime + step));
    setCurrent(audio.currentTime);
  };

  if (failed) return <FileAttachmentCard url={url} />;

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const peaks = loaded?.peaks ?? waveformPeaks([], BARS);
  const silent = muted || volume === 0;

  return (
    <div
      ref={rootRef}
      className="flex w-full max-w-sm items-center gap-2.5 rounded-lg border border-border bg-secondary/30 px-2.5 py-2"
    >
      <button
        type="button"
        onClick={toggle}
        disabled={!loaded}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 cursor-pointer"
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
      >
        {!loaded ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="h-4 w-4 translate-x-px fill-current" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={loaded ? 0 : -1}
          aria-label="Voice message position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatVoiceTime(current)} of ${formatVoiceTime(duration)}`}
          className="flex h-8 cursor-pointer touch-none items-center gap-[2px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX, e.currentTarget);
          }}
          onKeyDown={onSeekKey}
        >
          {peaks.map((peak, i) => (
            <div
              key={i}
              className={cn(
                "flex-1 rounded-full transition-colors",
                (i + 0.5) / peaks.length <= progress ? "bg-primary" : "bg-muted-foreground/35",
              )}
              style={{ height: `${Math.round(peak * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-2xs tabular-nums text-muted-foreground">
          <Mic className="h-3 w-3" />
          <span>
            {isPlaying || current > 0 ? `${formatVoiceTime(current)} / ` : ""}
            {formatVoiceTime(duration)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
          aria-label={silent ? "Unmute" : "Mute"}
          title={silent ? "Unmute" : "Mute"}
        >
          {silent ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <Slider
          className="w-16"
          min={0}
          max={100}
          step={1}
          value={[muted ? 0 : Math.round(volume * 100)]}
          onValueChange={([v]) => {
            setVolume(v / 100);
            if (v > 0) setMuted(false);
          }}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
