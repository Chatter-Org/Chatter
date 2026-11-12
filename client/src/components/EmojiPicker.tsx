import { useState, useMemo, useRef, useEffect, type ReactNode, type KeyboardEvent, type ComponentType } from "react";
import {
  Car,
  Clock,
  Hand,
  Heart,
  Leaf,
  Lightbulb,
  PawPrint,
  Pizza,
  Search,
  Shapes,
  Smile,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import {
  emojiShortcodes,
  filterEmojiCatalog,
  getFrequentEmojis,
  isCustomEmojiUrl,
  recordEmojiUsage,
} from "@chatter/core/emojiCatalog";
import { cn } from "@/lib/utils";

export { isCustomEmojiUrl };

/** Render a text string that may contain :emoji{url}: markers into React nodes */
export function renderInlineEmojis(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /:emoji\{([^}]+)\}:/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <img key={match.index} src={match[1]} alt="emoji" className="inline-block h-4 w-4 object-contain align-middle mx-0.5" />
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

/** Two full rows of the eight-column grid. */
const FREQUENT_SHOWN = 16;

const SECTION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "Frequently Used": Clock,
  Room: Sparkles,
  Smileys: Smile,
  Gestures: Hand,
  Hearts: Heart,
  Animals: PawPrint,
  Nature: Leaf,
  Food: Pizza,
  Activities: Trophy,
  Travel: Car,
  Objects: Lightbulb,
  Symbols: Shapes,
};

interface Section {
  id: string;
  label: string;
  emojis: string[];
}

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  roomCustomEmojis?: string[];
  emojiAliases?: Record<string, string>;
}

export function EmojiPicker({ onSelect, roomCustomEmojis, emojiAliases }: EmojiPickerProps) {
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Read once per opening: reordering the list under the pointer while the
  // picker is open would move the emoji someone is about to click again.
  const [frequentEmojis] = useState(() => getFrequentEmojis().slice(0, FREQUENT_SHOWN));
  const searching = search.trim() !== "";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { categories, custom } = useMemo(
    () => filterEmojiCatalog(search, roomCustomEmojis, emojiAliases),
    [search, roomCustomEmojis, emojiAliases],
  );

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (!searching && frequentEmojis.length > 0) {
      out.push({ id: "Frequently Used", label: "Frequently Used", emojis: frequentEmojis });
    }
    if (custom.length > 0) out.push({ id: "Room", label: "Room", emojis: custom });
    for (const [cat, emojis] of categories) out.push({ id: cat, label: cat, emojis });
    return out;
  }, [searching, frequentEmojis, custom, categories]);

  // A new search starts at the top, with the first result previewed — it is
  // what Enter picks.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
    setPreview(searching ? (sections[0]?.emojis[0] ?? null) : null);
    setActiveSection(sections[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const customAliases = useMemo(() => {
    const byUrl: Record<string, string> = {};
    for (const [name, url] of Object.entries(emojiAliases ?? {})) byUrl[url] ??= name;
    return byUrl;
  }, [emojiAliases]);

  const nameOf = (emoji: string): string => {
    if (isCustomEmojiUrl(emoji)) {
      const alias = customAliases[emoji];
      return alias ? `:${alias}:` : "Custom emoji";
    }
    const names = emojiShortcodes(emoji);
    return names.length > 0 ? `:${names[0]}:` : "";
  };

  const choose = (emoji: string) => {
    recordEmojiUsage(emoji);
    onSelect(emoji);
  };

  const cells = () => Array.from(scrollerRef.current?.querySelectorAll<HTMLButtonElement>("[data-emoji]") ?? []);

  const focusCell = (cell: HTMLButtonElement | undefined) => {
    if (!cell) return;
    cell.focus({ preventScroll: true });
    cell.scrollIntoView({ block: "nearest" });
  };

  /** Arrow keys move through the grid by position, so Up/Down land in the
   * same column even across a section boundary. */
  const handleGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-emoji]");
    if (!from) return;
    const all = cells();
    const i = all.indexOf(from);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusCell(all[i + 1]);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (i === 0) inputRef.current?.focus();
      else focusCell(all[i - 1]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      const r = from.getBoundingClientRect();
      let rowTop: number | null = null;
      let best: HTMLButtonElement | undefined;
      let bestDx = Infinity;
      for (const c of all) {
        const cr = c.getBoundingClientRect();
        const ahead = down ? cr.top > r.top + 1 : cr.top < r.top - 1;
        if (!ahead) continue;
        if (rowTop === null || (down ? cr.top < rowTop - 1 : cr.top > rowTop + 1)) {
          rowTop = cr.top;
          best = undefined;
          bestDx = Infinity;
        }
        if (Math.abs(cr.top - rowTop) <= 1) {
          const dx = Math.abs(cr.left - r.left);
          if (dx < bestDx) {
            bestDx = dx;
            best = c;
          }
        }
      }
      if (best) focusCell(best);
      else if (!down) inputRef.current?.focus();
    }
  };

  const handleSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusCell(cells()[0]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = sections[0]?.emojis[0];
      if (first) choose(first);
    }
  };

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let current = sections[0]?.id ?? null;
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-section]")) {
      if (el.offsetTop <= scroller.scrollTop + 4) current = el.dataset.section ?? current;
    }
    setActiveSection(current);
  };

  const jumpTo = (id: string) => {
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
    if (!scroller || !el) return;
    scroller.scrollTo({ top: el.offsetTop });
    setActiveSection(id);
  };

  const emojiFromEvent = (target: EventTarget) =>
    (target as HTMLElement).closest<HTMLElement>("[data-emoji]")?.dataset.emoji ?? null;

  // The grid is several hundred buttons; build it only when the emoji shown
  // change, not on every hover that moves the preview.
  const grid = useMemo(
    () =>
      sections.map((section) => (
        <section key={section.id} data-section={section.id} className="pb-1">
          <h3 className="ui-heading sticky top-0 z-10 bg-popover/95 px-1.5 pt-2 pb-1.5 backdrop-blur-sm">
            {section.label}
          </h3>
          <div className="grid grid-cols-8">
            {section.emojis.map((e) => (
              <button
                key={e}
                type="button"
                tabIndex={-1}
                data-emoji={e}
                aria-label={nameOf(e) || e}
                className="group flex size-10 scroll-mt-9 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isCustomEmojiUrl(e) ? (
                  <img
                    src={e}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="size-7 object-contain transition-transform duration-100 group-hover:scale-115"
                  />
                ) : (
                  <span className="text-[1.75rem] leading-none transition-transform duration-100 group-hover:scale-115">
                    {e}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )),
    // nameOf depends only on customAliases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, customAliases],
  );

  const previewName = preview ? nameOf(preview) : "";

  return (
    <div className="flex h-[min(27rem,70dvh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden">
      <div className="p-2 pb-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search emoji"
            aria-label="Search emoji"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKey}
            className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                inputRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {!searching && (
        <div className="flex items-center justify-between border-b border-border px-1.5 pb-1">
          {sections.map((s) => {
            const Icon = SECTION_ICONS[s.id] ?? Shapes;
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                type="button"
                title={s.label}
                aria-label={s.label}
                onClick={() => jumpTo(s.id)}
                className={cn(
                  "flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={scrollerRef}
        aria-label="Emoji"
        onScroll={handleScroll}
        onKeyDown={handleGridKey}
        onClick={(e) => {
          const emoji = emojiFromEvent(e.target);
          if (emoji) choose(emoji);
        }}
        onMouseOver={(e) => {
          const emoji = emojiFromEvent(e.target);
          if (emoji) setPreview(emoji);
        }}
        onFocus={(e) => {
          const emoji = emojiFromEvent(e.target);
          if (emoji) setPreview(emoji);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {grid}
        {sections.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-muted-foreground">
            <span className="text-3xl">🔍</span>
            <p className="text-sm">No emoji match “{search.trim()}”</p>
          </div>
        )}
      </div>

      <div className="flex h-12 shrink-0 items-center gap-2.5 border-t border-border bg-muted/40 px-3">
        {preview ? (
          <>
            {isCustomEmojiUrl(preview) ? (
              <img src={preview} alt="" className="size-7 object-contain" />
            ) : (
              <span className="text-[1.75rem] leading-none">{preview}</span>
            )}
            <span className="truncate text-sm font-medium text-foreground">{previewName}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Hover an emoji to see its name</span>
        )}
      </div>
    </div>
  );
}
