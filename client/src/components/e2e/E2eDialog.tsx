import { useState } from "react";
import { MIN_PASSPHRASE_LENGTH } from "@chatter/core/e2e/crypto";
import { setUpE2e, unlockE2e } from "@chatter/core/e2e/session";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useE2eStatus } from "@/hooks/useE2eStatus";

interface E2eDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Mode = "setup" | "unlock" | "reset";

/**
 * Set up, unlock or start over with end-to-end encryption.
 *
 * The passphrase is the only way back in on a new device, and the server
 * cannot recover it — the copy it keeps is sealed under it. Starting over
 * makes new keys: what was sent before cannot be read by this account again.
 */
export function E2eDialog({ open, onOpenChange }: E2eDialogProps) {
  const status = useE2eStatus();
  const [resetting, setResetting] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode: Mode = status === "locked" ? (resetting ? "reset" : "unlock") : "setup";
  const choosing = mode !== "unlock";

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPassphrase("");
      setConfirm("");
      setError(null);
      setResetting(false);
    }
    onOpenChange(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (choosing) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters`);
        return;
      }
      if (passphrase !== confirm) {
        setError("The passphrases don't match");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "unlock") {
        if (!(await unlockE2e(passphrase))) {
          setError("That passphrase isn't right");
          return;
        }
      } else {
        await setUpE2e(passphrase, mode === "reset");
      }
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const title = {
    setup: "Set up encrypted messages",
    unlock: "Unlock encrypted messages",
    reset: "Start over with new keys",
  }[mode];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "setup" &&
              "Direct messages are end-to-end encrypted: only the people in the conversation can read them. Choose a passphrase to protect your keys. You'll need it to read your messages on a new device, and it can't be recovered if you forget it."}
            {mode === "unlock" && "Enter your encryption passphrase to read your direct messages on this device."}
            {mode === "reset" &&
              "New keys mean you won't be able to read any encrypted message sent before now, on any device. The people you talk to are given your new keys automatically."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            autoComplete={choosing ? "new-password" : "current-password"}
            placeholder={choosing ? "New passphrase" : "Passphrase"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
          />
          {choosing && (
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm passphrase"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Files and images you send are not encrypted yet. Only the text of your messages is.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            {mode === "unlock" ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline cursor-pointer"
                onClick={() => {
                  setResetting(true);
                  setPassphrase("");
                  setError(null);
                }}
              >
                Forgot your passphrase?
              </button>
            ) : mode === "reset" ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline cursor-pointer"
                onClick={() => {
                  setResetting(false);
                  setPassphrase("");
                  setConfirm("");
                  setError(null);
                }}
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy} variant={mode === "reset" ? "destructive" : "default"}>
              {busy ? "Working…" : mode === "unlock" ? "Unlock" : mode === "reset" ? "Make new keys" : "Set up"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
