import { useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRemoveTimeout, apiTimeoutMember } from "@/lib/api";
import { useAppContext } from "@/lib/store";
import { formatTimeoutEnd } from "./moderationUtils";

/** The lengths offered, in seconds. The server takes anything from a minute
 *  to 28 days; these are the ones people actually reach for. */
const TIMEOUT_CHOICES: { label: string; secs: number }[] = [
  { label: "60 seconds", secs: 60 },
  { label: "5 minutes", secs: 5 * 60 },
  { label: "10 minutes", secs: 10 * 60 },
  { label: "1 hour", secs: 60 * 60 },
  { label: "1 day", secs: 24 * 60 * 60 },
  { label: "1 week", secs: 7 * 24 * 60 * 60 },
];

/**
 * Timeout controls for a member, shown to whoever can kick them — the server
 * gates timeouts on the same permission and hierarchy.
 */
export function MemberModerationActions({ roomId, userId, displayName }: { roomId: string; userId: string; displayName: string }) {
  const { state } = useAppContext();
  const member = state.roomMembers.find((m) => m.userId === userId);
  // Set only while in force: the server lists no ended timeout, and the
  // reducer drops one that a socket event says is over.
  const timedOutUntil = member?.timeoutUntil ?? 0;
  const [choosing, setChoosing] = useState(false);
  const [secs, setSecs] = useState(TIMEOUT_CHOICES[2].secs);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      await apiTimeoutMember(roomId, userId, secs, reason.trim());
      toast.success(`${displayName} is timed out`);
      setChoosing(false);
      setReason("");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to time out member");
    } finally {
      setBusy(false);
    }
  };

  const lift = async () => {
    setBusy(true);
    try {
      await apiRemoveTimeout(roomId, userId);
      toast.success(`${displayName}'s timeout was removed`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to remove timeout");
    } finally {
      setBusy(false);
    }
  };

  if (timedOutUntil) {
    return (
      <Button
        variant="outline"
        className="w-full text-orange-400 border-orange-400/30 hover:bg-orange-400/10"
        disabled={busy}
        onClick={lift}
        title={`Timed out until ${formatTimeoutEnd(timedOutUntil)}`}
      >
        <Clock className="h-4 w-4" />
        Remove timeout (until {formatTimeoutEnd(timedOutUntil)})
      </Button>
    );
  }

  if (!choosing) {
    return (
      <Button
        variant="outline"
        className="w-full text-orange-400 border-orange-400/30 hover:bg-orange-400/10"
        onClick={() => setChoosing(true)}
      >
        <Clock className="h-4 w-4" />
        Timeout
      </Button>
    );
  }

  return (
    <div className="space-y-1.5 rounded-md border border-orange-400/30 p-2">
      <p className="text-xs text-muted-foreground">
        {displayName} will be able to read, but not post, react or speak.
      </p>
      <select
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        value={secs}
        onChange={(e) => setSecs(Number(e.target.value))}
      >
        {TIMEOUT_CHOICES.map((c) => (
          <option key={c.secs} value={c.secs}>{c.label}</option>
        ))}
      </select>
      <Input
        placeholder="Reason (optional, shown in the audit log)"
        value={reason}
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
        className="text-sm"
      />
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => setChoosing(false)}>
          Cancel
        </Button>
        <Button size="sm" className="flex-1" disabled={busy} onClick={apply}>
          {busy ? "…" : "Time out"}
        </Button>
      </div>
    </div>
  );
}
