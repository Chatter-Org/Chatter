import { useState } from "react";
import { Pencil } from "lucide-react";

/** Matches `VOICE_CHANNEL_STATUS_MAX_CHARS` on the server, which cuts anything longer. */
const MAX_CHARS = 100;

interface VoiceChannelStatusProps {
  status?: string;
  /** Only someone in the call may set it. */
  canEdit: boolean;
  onSave: (status: string) => void;
}

/**
 * The line under a voice channel's name. Shown to everyone while it is set;
 * the people in the call can click it to change it, or set one when there is
 * none (the prompt appears on hover, and always on a touch screen). Enter or
 * leaving the field saves, Escape cancels, and an empty field clears it.
 */
export function VoiceChannelStatus({ status, canEdit, onSave }: VoiceChannelStatusProps) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    const commit = () => {
      setDraft(null);
      if (draft.trim() !== (status ?? "")) onSave(draft.trim());
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={MAX_CHARS}
        placeholder="What's going on in here?"
        aria-label="Voice channel status"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        className="block w-full rounded border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-ring"
      />
    );
  }

  if (!status && !canEdit) return null;

  if (!canEdit) {
    return (
      <div className="truncate px-1 text-xs text-muted-foreground" title={status}>
        {status}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setDraft(status ?? "")}
      title={status ? `${status} (click to change)` : "Set a channel status"}
      className={`flex w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground transition-opacity hover:text-foreground cursor-pointer ${
        status ? "" : "opacity-0 group-hover/voice:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
      }`}
    >
      <span className="truncate">{status || "Set a channel status"}</span>
      <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/voice:opacity-70 max-md:opacity-70" />
    </button>
  );
}
