import { useState } from "react";
import { resetE2e, unlockE2e } from "@chatter/core/e2e/session";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useE2eStatus } from "@/hooks/useE2eStatus";

interface E2eDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open straight to making new keys, for someone who suspects theirs are out. */
  startOver?: boolean;
}

type Mode = "unlock" | "reset";

/**
 * Unlock encrypted messages on this device with the recovery key, or start
 * over with new keys.
 *
 * Keys are made for people when they first use an encrypted DM, so there is
 * nothing to set up here. The recovery key is the only way back in on a new
 * device, and the server cannot recover it — the copy it keeps is sealed
 * under it. Starting over makes new keys and a new recovery key: what was sent
 * before cannot be read by this account again.
 */
export function E2eDialog({ open, onOpenChange, startOver = false }: E2eDialogProps) {
  const status = useE2eStatus();
  const [resetting, setResetting] = useState(false);
  const [secret, setSecret] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode: Mode = startOver || resetting ? "reset" : "unlock";

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSecret("");
      setTotpCode("");
      setError(null);
      setResetting(false);
    }
    onOpenChange(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (mode === "reset" && !totpCode.trim()) {
      setError("Enter the code from your authenticator app");
      return;
    }
    setBusy(true);
    try {
      if (mode === "unlock") {
        if (!(await unlockE2e(secret))) {
          setError("That isn't the right recovery key");
          return;
        }
      } else {
        await resetE2e(totpCode.trim());
      }
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open && (status === "locked" || status === "ready")} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "unlock" ? "Unlock encrypted messages" : "Make new encryption keys"}</DialogTitle>
          <DialogDescription>
            {mode === "unlock"
              ? "Enter your recovery key to read your direct messages on this device. A password manager may fill it in."
              : "New keys mean you won't be able to read any encrypted message sent before now, on any device. The people you talk to are told your keys changed, and you'll get new messages once they accept it. You'll be given a new recovery key."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {mode === "unlock" ? (
            <>
              {/* Gives a password manager something to file the key under. */}
              <input type="text" name="username" autoComplete="username" value="Chatter encryption key" readOnly hidden />
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="Recovery key"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoFocus
              />
            </>
          ) : (
            // Changing who can read the account's messages takes more than
            // being signed in.
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Authenticator code (or a 2FA recovery code)"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              autoFocus
            />
          )}
          <p className="text-xs text-muted-foreground">
            Your messages, files and images are encrypted. The server can still see who you talk to, when, and how big a file is.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            {mode === "unlock" ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline cursor-pointer"
                onClick={() => {
                  setResetting(true);
                  setSecret("");
                  setError(null);
                }}
              >
                Lost your recovery key?
              </button>
            ) : !startOver ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline cursor-pointer"
                onClick={() => {
                  setResetting(false);
                  setTotpCode("");
                  setError(null);
                }}
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy} variant={mode === "reset" ? "destructive" : "default"}>
              {busy ? "Working…" : mode === "unlock" ? "Unlock" : "Make new keys"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
