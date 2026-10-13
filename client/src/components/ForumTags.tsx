import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  apiSetForumTags,
  MAX_FORUM_TAGS,
  MAX_POST_TAGS,
  MAX_TAG_NAME,
  type ForumTag,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useReadableColor } from "@/lib/theme";

/** One tag as a chip, tinted with its colour when it has one. */
export function ForumTagChip({
  tag,
  selected,
  onClick,
  size = "sm",
}: {
  tag: ForumTag;
  /** Only meaningful for a chip that is a toggle (a picker or a filter). */
  selected?: boolean;
  onClick?: () => void;
  size?: "xs" | "sm";
}) {
  const readable = useReadableColor();
  // The colour was picked on someone's theme and is drawn on everyone's, so
  // it is adapted to this one: text at 4.5:1, the border at the 3:1 a
  // control's edge needs, and the tint taken from the adapted text colour.
  const text = readable(tag.color);
  const style = text
    ? { color: text, borderColor: readable(tag.color, 3), backgroundColor: `${text}${selected === false ? "00" : "1f"}` }
    : undefined;
  const className = cn(
    "inline-flex items-center rounded-full border font-medium whitespace-nowrap",
    size === "xs" ? "px-1.5 py-0 text-3xs" : "px-2 py-0.5 text-xs",
    !tag.color && (selected ? "bg-accent border-foreground/30" : "border-border text-muted-foreground"),
    selected === false && "opacity-60 hover:opacity-100",
    onClick && "cursor-pointer transition-opacity",
  );
  if (!onClick) {
    return (
      <span className={className} style={style}>
        {tag.name}
      </span>
    );
  }
  return (
    <button type="button" className={className} style={style} onClick={onClick} aria-pressed={selected}>
      {tag.name}
    </button>
  );
}

/** The tags a post wears, in the channel's order. An id the channel has since
 *  dropped is skipped. */
export function ForumTagList({
  tagIds,
  tags,
  size = "sm",
}: {
  tagIds: string[] | undefined;
  tags: ForumTag[] | undefined;
  size?: "xs" | "sm";
}) {
  const worn = (tags ?? []).filter((t) => tagIds?.includes(t.tag_id));
  if (worn.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {worn.map((t) => (
        <ForumTagChip key={t.tag_id} tag={t} size={size} />
      ))}
    </div>
  );
}

/** Choosing a post's tags from what its channel offers. */
export function ForumTagPicker({
  tags,
  value,
  onChange,
}: {
  tags: ForumTag[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  if (tags.length === 0) return null;
  const full = value.length >= MAX_POST_TAGS;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Tags <span className="font-normal">(up to {MAX_POST_TAGS})</span>
      </p>
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => {
          const on = value.includes(t.tag_id);
          return (
            <ForumTagChip
              key={t.tag_id}
              tag={t}
              selected={on}
              onClick={() => {
                if (on) onChange(value.filter((id) => id !== t.tag_id));
                else if (!full) onChange([...value, t.tag_id]);
                else toast.error(`A post can have at most ${MAX_POST_TAGS} tags`);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

type DraftTag = { tag_id?: string; name: string; color: string; key: string };

let draftKey = 0;
const toDraft = (t: ForumTag): DraftTag => ({ ...t, key: t.tag_id });

/** Setting up the tags a forum channel offers. Saved whole: a tag removed
 *  here disappears from every post wearing it. */
export function ManageForumTagsDialog({
  open,
  onOpenChange,
  roomId,
  channelId,
  tags,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  channelId: string;
  tags: ForumTag[];
}) {
  const [draft, setDraft] = useState<DraftTag[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(tags.map(toDraft));
  }, [open, tags]);

  const update = (key: string, patch: Partial<DraftTag>) =>
    setDraft((d) => d.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  const save = async () => {
    const cleaned = draft.map((t) => ({ ...t, name: t.name.trim() }));
    if (cleaned.some((t) => !t.name)) {
      toast.error("Every tag needs a name");
      return;
    }
    setSaving(true);
    try {
      // The channel list picks the new set up from the update broadcast.
      await apiSetForumTags(
        roomId,
        channelId,
        cleaned.map(({ tag_id, name, color }) => ({ tag_id, name, color })),
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save tags");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Forum tags</DialogTitle>
          <DialogDescription>
            The tags people can put on their posts in this forum.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {draft.length === 0 && (
            <p className="text-sm text-muted-foreground">No tags yet.</p>
          )}
          {draft.map((t) => (
            <div key={t.key} className="flex items-center gap-2">
              <input
                type="color"
                value={t.color || "#888888"}
                onChange={(e) => update(t.key, { color: e.target.value })}
                className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
                aria-label={`Colour for ${t.name || "tag"}`}
              />
              <Input
                value={t.name}
                maxLength={MAX_TAG_NAME}
                placeholder="Tag name"
                onChange={(e) => update(t.key, { name: e.target.value })}
                className="h-8 text-sm"
              />
              {t.color && (
                <button
                  type="button"
                  className="text-3xs text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                  onClick={() => update(t.key, { color: "" })}
                  title="Use no colour"
                >
                  Clear
                </button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => setDraft((d) => d.filter((x) => x.key !== t.key))}
                aria-label={`Remove ${t.name || "tag"}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {draft.length < MAX_FORUM_TAGS && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setDraft((d) => [...d, { name: "", color: "", key: `new-${++draftKey}` }])}
            >
              <Plus className="h-4 w-4" />
              Add tag
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
