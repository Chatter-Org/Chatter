import { useState, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { displayUserId } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "@/components/AuthImage";
import { Lock, LockOpen, X } from "lucide-react";

const MAX_DM_MEMBERS = 20;

interface NewDMDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Start a DM: one person picked makes a private DM, several a group DM.
 *  Either can be end-to-end encrypted or not; encrypted is the default. */
export function NewDMDialog({ open, onOpenChange }: NewDMDialogProps) {
  const { state, openDM } = useAppContext();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [e2e, setE2e] = useState(true);

  const maxSelectable = MAX_DM_MEMBERS - 1; // excluding self

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return Object.entries(state.userPresence)
      .filter(([uid]) => {
        if (uid === state.userId) return false;
        if (selected.includes(uid)) return false;
        if (!q) return true;
        const display = (state.userPresence[uid]?.displayName || displayUserId(uid)).toLowerCase();
        return display.includes(q) || uid.toLowerCase().includes(q);
      })
      .slice(0, 20);
  }, [search, state.userPresence, state.userId, selected]);

  function toggle(uid: string) {
    setSelected((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  }

  async function handleCreate() {
    if (selected.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      await openDM(selected, { e2e });
      handleOpenChange(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create DM");
    } finally {
      setCreating(false);
    }
  }

  function handleOpenChange(val: boolean) {
    if (!val) {
      setSearch("");
      setSelected([]);
      setError(null);
      setE2e(true);
    }
    onOpenChange(val);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New DM</DialogTitle>
          <DialogDescription>
            Pick one person for a private DM, or up to {maxSelectable} for a group DM ({selected.length}/{maxSelectable} selected)
          </DialogDescription>
        </DialogHeader>

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selected.map((uid) => {
              const display = state.userPresence[uid]?.displayName || displayUserId(uid);
              return (
                <span
                  key={uid}
                  className="flex items-center gap-1 text-xs bg-accent rounded-full px-2 py-0.5"
                >
                  {display}
                  <button onClick={() => toggle(uid)} className="hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <Input
          placeholder="Search users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {search ? "No users found" : "No other users available"}
            </p>
          ) : (
            candidates.map(([uid, presence]) => {
              const displayName = presence?.displayName || displayUserId(uid);
              const initial = displayName.substring(0, 1).toUpperCase();
              const isSelected = selected.includes(uid);
              const disableAdd = !isSelected && selected.length >= maxSelectable;
              return (
                <div
                  key={uid}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer ${isSelected ? "bg-accent" : "hover:bg-accent/50"} ${disableAdd ? "opacity-50 cursor-not-allowed" : ""}`}
                  role="button"
                  tabIndex={disableAdd ? -1 : 0}
                  aria-pressed={isSelected}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!disableAdd) toggle(uid); }
                  }}
                  onClick={() => !disableAdd && toggle(uid)}
                >
                  <Avatar className="h-7 w-7 shrink-0">
                    <AuthAvatarImage src={presence?.avatarUrl} />
                    <AvatarFallback className="text-xs">{initial}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm truncate">{displayName}</span>
                  {isSelected && (
                    <span className="ml-auto text-xs text-primary">Selected</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
          {e2e ? (
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <LockOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <Label htmlFor="new-dm-e2e" className="text-sm font-medium">
              End-to-end encrypted
            </Label>
            <p className="text-xs text-muted-foreground">
              {e2e
                ? "Only members can read messages. Files are not encrypted yet, and the Android app cannot send here yet."
                : "The server can read messages. Works in every app."}
            </p>
          </div>
          <Switch id="new-dm-e2e" checked={e2e} onCheckedChange={setE2e} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={selected.length === 0 || creating}
          >
            {creating ? "Creating..." : selected.length > 1 ? "Create Group DM" : "Create DM"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
