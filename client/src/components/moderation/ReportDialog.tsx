import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiReportMessage } from "@/lib/api";
import { onShowReportDialog, type ReportTarget } from "./moderationUtils";

/** Common reasons, offered as one tap. Free text is still taken. */
const QUICK_REASONS = ["Spam", "Harassment", "Hate speech", "Explicit content", "Scam or phishing"];

/** Report a message to the room's moderators. Mounted once, in the layout. */
export function ReportDialog() {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(
    () =>
      onShowReportDialog((t) => {
        setTarget(t);
        setReason("");
      }),
    [],
  );

  const submit = async () => {
    if (!target) return;
    setSending(true);
    try {
      await apiReportMessage(target.roomId, target.eventId, reason.trim());
      toast.success("Reported. The room's moderators will take a look.");
      setTarget(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to report the message");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report message</DialogTitle>
          <DialogDescription>
            {target ? `Your report about ${target.senderName}'s message goes to this room's moderators. ` : ""}
            They see who reported it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_REASONS.map((r) => (
            <Button
              key={r}
              type="button"
              size="sm"
              variant={reason === r ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => setReason(r)}
            >
              {r}
            </Button>
          ))}
        </div>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What's wrong with it? (optional)"
          maxLength={500}
          className="min-h-20 text-sm"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setTarget(null)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={sending}>
            {sending ? "Reporting…" : "Report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
