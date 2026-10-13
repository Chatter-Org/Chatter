import type { MentionMatch } from "@/lib/mentions";
import { useReadableColor } from "@/lib/theme";

/** The popup listing mention candidates above a composer. */
export function MentionMenu({
  matches,
  selectedIdx,
  onSelect,
}: {
  matches: MentionMatch[];
  selectedIdx: number;
  onSelect: (name: string) => void;
}) {
  const readable = useReadableColor();
  if (matches.length === 0) return null;
  return (
    <div className="absolute bottom-full left-0 mb-1 w-56 rounded-md border bg-popover p-1 shadow-lg z-50">
      {matches.map((m, i) => {
        const color = m.kind === "role" ? readable(m.color) : "";
        return (
        <button
          key={`${m.kind}-${m.id}`}
          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer transition-colors ${
            i === selectedIdx ? "bg-accent" : "hover:bg-accent/50"
          }`}
          onMouseDown={(e) => {
            // Keep focus (and the caret) in the composer.
            e.preventDefault();
            onSelect(m.name);
          }}
        >
          {m.kind === "role" ? (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
              style={{ backgroundColor: color ? `${color}33` : undefined, color: color || undefined }}
            >
              @
            </span>
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
              {m.name[0]?.toUpperCase()}
            </span>
          )}
          <span style={color ? { color } : undefined}>{m.name}</span>
          {m.kind === "role" && (
            <span className="ml-auto text-xs text-muted-foreground">Role</span>
          )}
        </button>
        );
      })}
    </div>
  );
}
