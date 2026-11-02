import { useEffect, useRef } from "react";
import { Mic, SendHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VoiceRecorder } from "@/hooks/useVoiceRecorder";
import { VOICE_MESSAGE_MAX_SECONDS, formatVoiceTime } from "@chatter/core/voiceMessage";

/** The composer's mic button: starts a recording. */
export function VoiceRecordButton({
  recorder,
  className,
  iconClassName = "h-4 w-4",
  disabled,
}: {
  recorder: VoiceRecorder;
  className?: string;
  iconClassName?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("shrink-0", className)}
      onClick={() => void recorder.start()}
      disabled={disabled || recorder.recording}
      title="Record a voice message"
      aria-label="Record a voice message"
    >
      <Mic className={iconClassName} />
    </Button>
  );
}

/**
 * What the composer shows while recording, laid over it: discard, the time,
 * a live level meter, and send. Escape discards and Enter sends.
 */
export function VoiceRecordingBar({
  recorder,
  onSend,
  className,
}: {
  recorder: VoiceRecorder;
  onSend: (file: File) => void;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const send = async () => {
    const file = await recorder.finish();
    if (file) onSend(file);
  };

  const remaining = VOICE_MESSAGE_MAX_SECONDS - recorder.elapsed;
  const bars = Array.from({ length: 32 }, (_, i) => recorder.levels[recorder.levels.length - 32 + i] ?? 0);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-label="Recording a voice message"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          recorder.cancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          void send();
        }
      }}
      className={cn(
        "absolute inset-0 z-20 flex items-center gap-2 rounded-xl bg-secondary px-1.5 focus-visible:outline-none",
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={recorder.cancel}
        title="Discard (Esc)"
        aria-label="Discard voice message"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
      </span>
      <span className="shrink-0 text-sm tabular-nums" aria-live="off">
        {formatVoiceTime(recorder.elapsed)}
      </span>
      <div className="flex h-6 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
        {bars.map((level, i) => (
          <div
            key={i}
            className="flex-1 rounded-full bg-primary/70"
            style={{ height: `${Math.max(8, Math.round(level * 100))}%` }}
          />
        ))}
      </div>
      {remaining <= 30 && (
        <span className="shrink-0 text-2xs text-warning">{Math.ceil(remaining)}s left</span>
      )}
      <Mic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <Button
        type="button"
        size="icon"
        className="shrink-0 rounded-lg"
        onClick={() => void send()}
        title="Send voice message (Enter)"
        aria-label="Send voice message"
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
