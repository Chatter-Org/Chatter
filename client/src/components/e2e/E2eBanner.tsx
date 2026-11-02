import { useState, useSyncExternalStore } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { acceptKeyChange, getChangedKeys, getKeysReplacedElsewhere, startE2e, subscribeE2e } from "@chatter/core/e2e/session";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/lib/store";
import { useE2eStatus } from "@/hooks/useE2eStatus";
import { displayUserId } from "@/lib/utils";
import { E2eDialog } from "./E2eDialog";

/**
 * Shown at the top of an encrypted DM until this device can read it — the
 * account has never set up encryption, or this device has not been unlocked —
 * and whenever someone in it has keys this device has not seen before.
 */
export function E2eBanner() {
  const status = useE2eStatus();
  const changed = useSyncExternalStore(subscribeE2e, getChangedKeys);
  const replacedElsewhere = useSyncExternalStore(subscribeE2e, getKeysReplacedElsewhere);
  const { state } = useAppContext();
  const [open, setOpen] = useState(false);

  const members = new Set(state.roomMembers.map((m) => m.userId));
  const changedHere = changed.filter((id) => members.has(id));

  return (
    <>
      {status !== "ready" && status !== "off" && (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-4 py-2 text-sm shrink-0">
          <span className="flex items-center gap-2 min-w-0">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              {status === "setup"
                ? "This conversation is end-to-end encrypted. Set up encryption to read and send messages."
                : status === "locked"
                  ? replacedElsewhere
                    ? "Your encryption keys were changed from somewhere else. If that wasn't you, change your password. Otherwise unlock with your new passphrase."
                    : "This conversation is end-to-end encrypted. Unlock it on this device to read and send messages."
                  : "Couldn't load your encryption keys."}
            </span>
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
      )}
      {changedHere.map((userId) => (
        <KeyChangeNotice key={userId} userId={userId} />
      ))}
    </>
  );
}

/**
 * Someone's keys are not the ones this device first saw. Nothing is sent to
 * the new keys, and messages signed with them are not trusted, until the
 * person here says the change is genuine — which only they can find out, by
 * asking the other person some other way.
 */
function KeyChangeNotice({ userId }: { userId: string }) {
  const { state } = useAppContext();
  const name = state.userPresence[userId]?.displayName || displayUserId(userId);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-destructive/10 px-4 py-2 text-sm shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0">
          {name}'s encryption keys changed. They may have reset them — or someone else may have taken over their
          account. Check with them some other way before you trust the new keys. Until then nothing you send reaches them.
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await acceptKeyChange(userId);
          } finally {
            setBusy(false);
          }
        }}
      >
        Trust new keys
      </Button>
    </div>
  );
}
