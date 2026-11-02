import { useState } from "react";
import { Lock } from "lucide-react";
import { startE2e } from "@chatter/core/e2e/session";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/lib/store";
import { useE2eStatus } from "@/hooks/useE2eStatus";
import { E2eDialog } from "./E2eDialog";

/**
 * Shown at the top of an encrypted DM until this device can read it: the
 * account has never set up encryption, or this device has not been unlocked.
 */
export function E2eBanner() {
  const status = useE2eStatus();
  const { state } = useAppContext();
  const [open, setOpen] = useState(false);
  if (status === "ready" || status === "off") return null;

  const text =
    status === "setup"
      ? "This conversation is end-to-end encrypted. Set up encryption to read and send messages."
      : status === "locked"
        ? "This conversation is end-to-end encrypted. Unlock it on this device to read and send messages."
        : "Couldn't load your encryption keys.";

  return (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-4 py-2 text-sm shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{text}</span>
      </span>
      {status === "error" ? (
        <Button size="sm" variant="outline" onClick={() => state.userId && void startE2e(state.userId)}>
          Try again
        </Button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          {status === "setup" ? "Set up" : "Unlock"}
        </Button>
      )}
      <E2eDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
