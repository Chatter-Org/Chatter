import { useState } from "react";
import { Pencil } from "lucide-react";

/** Matches `VOICE_CHANNEL_STATUS_MAX_CHARS` on the server, which cuts anything longer. */
const MAX_CHARS = 100;

interface VoiceChannelStatusProps {
  status?: string;
  /** Only someone in the call may set it. */
  canEdit: boolean;
  onSave: (status: string) => void;
  /** Open with the field already showing, as when set from the channel row. */
  startEditing?: boolean;
  /** Called when the field closes, saved or not. */
  onEditEnd?: () => void;
}

/**
 * The line under a voice channel's name. Shown to everyone while it is set;
 * the people in the call can click it to change it. Setting one when there is
 * none starts from a button on the channel row, which mounts this with
 * `startEditing`. Enter or leaving the field saves, Escape cancels, and an
 * empty field clears it.
 */
export function VoiceChannelStatus({ status, canEdit, onSave, startEditing, onEditEnd }: VoiceChannelStatusProps) {
  const [draft, setDraftState] = useState<string | null>(startEditing ? (status ?? "") : null);
  const setDraft = (next: string | null) => {
    setDraftState(next);
    if (next === null) onEditEnd?.();
  };

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
        className="block w-full rounded border bg-background px-1.5 py-0.5 text-[0.5625rem] leading-3 text-foreground outline-none focus:border-ring"
      />
    );
  }

  if (!status) return null;

  if (!canEdit) {
    return (
      <div className="truncate px-1 text-[0.5625rem] leading-3 text-muted-foreground" title={status}>
        {status}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setDraft(status ?? "")}
      title={`${status} (click to change)`}
      className="flex w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[0.5625rem] leading-3 text-muted-foreground transition-opacity hover:text-foreground cursor-pointer"
    >
      <span className="truncate">{status}</span>
      <Pencil className="h-[9px] w-[9px] shrink-0 opacity-0 group-hover/voice:opacity-70 max-md:opacity-70" />
    </button>
  );
}
