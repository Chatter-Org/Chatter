import { useState } from "react";
import { acknowledgeRecoveryKey } from "@chatter/core/e2e/session";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUnsavedRecoveryKey } from "@/hooks/useUnsavedRecoveryKey";

/** Chrome's password manager can take it; other browsers ignore the call. */
async function offerToPasswordManager(key: string): Promise<void> {
  try {
    const Credential = (window as unknown as { PasswordCredential?: new (init: object) => Credential }).PasswordCredential;
    if (!Credential || !navigator.credentials?.store) return;
    await navigator.credentials.store(
      new Credential({ id: "Chatter encryption key", name: "Chatter encryption key", password: key }),
    );
  } catch {
    // Declined, or not offered here.
  }
}

function download(key: string) {
  const url = URL.createObjectURL(
    new Blob([`Chatter encryption recovery key\n\n${key}\n\nKeep this somewhere safe. It is the only way to read your encrypted messages on a new device.\n`], {
      type: "text/plain",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "chatter-recovery-key.txt";
  a.click();
  URL.revokeObjectURL(url);
}

interface RecoveryKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shows the recovery key the app made, so the person can keep it. Nothing
 * else about encryption asks them to do anything; this is what lets a new
 * device, or a sign-out, get back to their messages.
 */
export function RecoveryKeyDialog({ open, onOpenChange }: RecoveryKeyDialogProps) {
  const key = useUnsavedRecoveryKey();
  const [copied, setCopied] = useState(false);

  if (!key) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keep your recovery key</DialogTitle>
          <DialogDescription>
            Your messages are protected by keys made for you. This recovery key gets you back to them on a new device or after
            signing out. We can't recover it for you, so put it somewhere safe — a password manager is ideal.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void offerToPasswordManager(key);
            void acknowledgeRecoveryKey();
            onOpenChange(false);
          }}
        >
          <div className="rounded-md border bg-muted/40 px-3 py-3 text-center font-mono text-sm tracking-wider select-all break-all">
            {key}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(key).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => download(key)}>
              Download
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Remind me later
            </button>
            <Button type="submit">I've saved it</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Opens by itself the first time a recovery key is waiting to be kept. */
export function RecoveryKeyPrompt() {
  const key = useUnsavedRecoveryKey();
  const [dismissed, setDismissed] = useState<string | null>(null);
  return <RecoveryKeyDialog open={!!key && dismissed !== key} onOpenChange={(open) => !open && setDismissed(key)} />;
}
