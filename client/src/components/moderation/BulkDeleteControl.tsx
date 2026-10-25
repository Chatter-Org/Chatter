import { useState } from "react";
import { Eraser } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiBulkDeleteMessages } from "@/lib/api";
import { cn } from "@/lib/utils";

const WINDOWS: { label: string; secs: number }[] = [
  { label: "Last hour", secs: 60 * 60 },
  { label: "Last 24 hours", secs: 24 * 60 * 60 },
  { label: "Last 7 days", secs: 7 * 24 * 60 * 60 },
];

/**
 * Delete someone's recent messages across the room — the cleanup after spam.
 * Works for people who have already left or been banned. `compact` draws it
 * as a small inline button, for lists.
 */
export function BulkDeleteControl({
  roomId,
  userId,
  displayName,
  compact = false,
}: {
  roomId: string;
  userId: string;
  displayName: string;
  compact?: boolean;
}) {
  const confirm = useConfirm();
  const [choosing, setChoosing] = useState(false);
  const [secs, setSecs] = useState(WINDOWS[1].secs);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const label = WINDOWS.find((w) => w.secs === secs)?.label.toLowerCase() ?? "";
    const ok = await confirm({
      title: `Delete ${displayName}'s messages?`,
      description: `Everything they posted in this room in the ${label}, including attachments. This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { deleted } = await apiBulkDeleteMessages(roomId, userId, secs);
      toast.success(deleted === 0 ? "They had no messages in that time" : `Deleted ${deleted} message${deleted === 1 ? "" : "s"}`);
      setChoosing(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete messages");
    } finally {
      setBusy(false);
    }
  };

  if (!choosing) {
    return (
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        className={cn(
          "text-destructive border-destructive/30 hover:bg-destructive/10",
          compact ? "h-7 shrink-0 text-xs" : "w-full",
        )}
        onClick={() => setChoosing(true)}
      >
        {!compact && <Eraser className="h-4 w-4" />}
        {compact ? "Delete messages" : "Delete recent messages"}
      </Button>
    );
  }

  return (
    <div className={cn("flex items-center gap-1.5", !compact && "w-full")}>
      <select
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={secs}
        onChange={(e) => setSecs(Number(e.target.value))}
      >
        {WINDOWS.map((w) => (
          <option key={w.secs} value={w.secs}>{w.label}</option>
        ))}
      </select>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setChoosing(false)}>
        Cancel
      </Button>
      <Button type="button" size="sm" variant="destructive" className="h-7" disabled={busy} onClick={run}>
        {busy ? "…" : "Delete"}
      </Button>
    </div>
  );
}
