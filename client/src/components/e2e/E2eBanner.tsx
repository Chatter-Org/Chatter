import { useEffect, useState, useSyncExternalStore } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import {
  acceptKeyChange,
  autoSetUpE2e,
  confirmMembers,
  getChangedKeys,
  getKeysReplacedElsewhere,
  getNewMembers,
  startE2e,
  subscribeE2e,
} from "@chatter/core/e2e/session";
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
  const newMembers = useSyncExternalStore(subscribeE2e, getNewMembers);
  const { state } = useAppContext();
  const [open, setOpen] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Nothing to set up by hand: the first encrypted DM makes the keys.
  useEffect(() => {
    if (status !== "setup") return;
    autoSetUpE2e().catch((err) => setSetupError(err instanceof Error ? err.message : "Couldn't set up encryption"));
  }, [status, attempt]);

  const members = new Set(state.roomMembers.map((m) => m.userId));
  const changedHere = changed.filter((id) => members.has(id));
  const roomId = state.currentRoomId;
  const newHere = roomId ? (newMembers[roomId] ?? []) : [];

  return (
    <>
      {status !== "ready" && status !== "off" && (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-4 py-2 text-sm shrink-0">
          <span className="flex items-center gap-2 min-w-0">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              {status === "setup"
                ? setupError
                  ? `Couldn't set up encryption: ${setupError}`
                  : "Setting up encryption…"
                : status === "locked"
                  ? replacedElsewhere
                    ? "Your encryption keys were changed from somewhere else. If that wasn't you, change your password. Otherwise unlock with your new recovery key."
                    : "This conversation is end-to-end encrypted. Unlock it on this device to read and send messages."
                  : "Couldn't load your encryption keys."}
            </span>
          </span>
          {status === "error" ? (
            <Button size="sm" variant="outline" onClick={() => state.userId && void startE2e(state.userId)}>
              Try again
            </Button>
          ) : status === "setup" ? (
            setupError && (
              <Button size="sm" variant="outline" onClick={() => {
                  setSetupError(null);
                  setAttempt((n) => n + 1);
                }}>
                Try again
              </Button>
            )
          ) : (
            <Button size="sm" onClick={() => setOpen(true)}>
              Unlock
            </Button>
          )}
          <E2eDialog open={open} onOpenChange={setOpen} />
        </div>
      )}
      {changedHere.map((userId) => (
        <KeyChangeNotice key={userId} userId={userId} />
      ))}
      {roomId &&
        newHere.map((userId) => <NewMemberNotice key={userId} roomId={roomId} userId={userId} />)}
    </>
  );
}

/**
 * Someone is in the conversation whom this device did not see join: the server
 * lists them, but they were not here when this device first saw the room, it
 * did not add them, and nobody here confirmed them. A member someone else
 * added looks like this — and so does one the server made up. This device
 * shares nothing with them until the person here says they belong.
 */
function NewMemberNotice({ roomId, userId }: { roomId: string; userId: string }) {
  const { state } = useAppContext();
  const name = state.userPresence[userId]?.displayName || displayUserId(userId);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-destructive/10 px-4 py-2 text-sm shrink-0">
      <span className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0">
          {name} is new in this conversation and wasn't added from this device. If you weren't expecting them, check
          with the others some other way. This device won't share the conversation's keys with them until you confirm.
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await confirmMembers(roomId, [userId]);
          } finally {
            setBusy(false);
          }
        }}
      >
        They belong here
      </Button>
    </div>
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
