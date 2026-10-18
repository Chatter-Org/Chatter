import { useState, useEffect, useRef, useCallback } from "react";
import { apiSearchGifs } from "@/lib/api";
import { gifFullUrl, gifPage, gifThumbUrl, type GifItem } from "@chatter/core/gifs";
import { Folder, Loader2, MoreHorizontal, Plus, Star } from "lucide-react";
import { useFavoriteGifs, loadGifFavorites, MAX_CATEGORY_NAME } from "@/hooks/useFavoriteGifs";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
}

const PER_PAGE = 12;

const tileButtonClass =
  "absolute top-1 p-0.5 rounded-sm bg-black/50 can-hover:opacity-0 can-hover:group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity";

/** Stops Radix's menu typeahead from swallowing keystrokes meant for an input inside it. */
function stopMenuKeys(e: React.KeyboardEvent) {
  if (e.key !== "Escape") e.stopPropagation();
}

/** The folder button on a GIF tile: tick the categories it belongs to, or start a new one. */
function GifCategoryMenu({ url }: { url: string }) {
  const { categories, setInCategory, createCategory } = useFavoriteGifs();
  const [newName, setNewName] = useState("");
  const inAny = categories.some((c) => c.urls.includes(url));

  const create = () => {
    const id = createCategory(newName);
    if (id) {
      setInCategory(id, url, true);
      setNewName("");
    }
  };

  return (
    <DropdownMenu onOpenChange={(open) => !open && setNewName("")}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(tileButtonClass, "left-1")}
          onClick={(e) => e.stopPropagation()}
          title="Add to category"
        >
          <Folder className={cn("h-3.5 w-3.5 text-white", inAny && "fill-white")} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs">Categories</DropdownMenuLabel>
        {categories.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={c.urls.includes(url)}
            onCheckedChange={(checked) => setInCategory(c.id, url, checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="truncate">{c.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {categories.length > 0 && <DropdownMenuSeparator />}
        <form
          className="flex items-center gap-1 px-1 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={stopMenuKeys}
            maxLength={MAX_CATEGORY_NAME}
            placeholder="New category…"
            className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="Create category"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A small text field that commits on Enter or blur and gives up on Escape. */
function ChipInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value.trim()) onCommit(value);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      maxLength={MAX_CATEGORY_NAME}
      placeholder="Category name"
      className="w-28 shrink-0 rounded-full border border-input bg-transparent px-2.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function GifPicker({ onSelect }: GifPickerProps) {
  const [tab, setTab] = useState<"search" | "favorites">("search");
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    favorites, categories, addFavorite, removeFavorite, isFavorite,
    createCategory, renameCategory, deleteCategory,
  } = useFavoriteGifs();
  // null is "All"; a category deleted out from under the view falls back to it.
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const activeCategory = categories.find((c) => c.id === categoryId) ?? null;
  const shownFavorites = activeCategory ? activeCategory.urls : favorites;

  const fetchGifs = useCallback(async (q: string, p: number, append: boolean) => {
    setLoading(true);
    try {
      const { items, hasNext } = gifPage(await apiSearchGifs(q, p, PER_PAGE));
      if (append) {
        setGifs((prev) => [...prev, ...items]);
      } else {
        setGifs(items);
      }
      setHasMore(hasNext);
    } catch {
      if (!append) setGifs([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Opening the picker is when favourites matter, so check they are current
  // rather than trusting a socket that may have missed a change.
  useEffect(() => {
    void loadGifFavorites();
  }, []);

  // Load trending on mount
  useEffect(() => {
    fetchGifs("", 1, false);
  }, [fetchGifs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      setHasMore(true);
      fetchGifs(query, 1, false);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchGifs]);

  const loadMore = () => {
    if (loading || !hasMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchGifs(query, nextPage, true);
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
      loadMore();
    }
  };

  const getThumbUrl = gifThumbUrl;
  const getFullUrl = gifFullUrl;

  return (
    <div className="w-80 flex flex-col">
      {/* Tabs */}
      <div className="flex border-b">
        <button
          className={cn(
            "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "search"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("search")}
        >
          Search
        </button>
        <button
          className={cn(
            "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "favorites"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("favorites")}
        >
          Favorites{favorites.length > 0 && ` (${favorites.length})`}
        </button>
      </div>

      {tab === "search" && (
        <>
          <div className="p-2 border-b">
            <input
              type="text"
              placeholder="Search GIFs..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoFocus
            />
          </div>
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="overflow-y-auto"
            style={{ maxHeight: "420px" }}
          >
            <div className="grid grid-cols-3 gap-1 p-2">
              {gifs.map((gif, i) => {
                const thumb = getThumbUrl(gif);
                const full = getFullUrl(gif);
                if (!thumb || !full) return null;
                const fav = isFavorite(full);
                return (
                  <div key={i} className="relative group">
                    <button
                      className="h-24 w-full overflow-hidden rounded-md border border-border hover:border-primary transition-colors cursor-pointer bg-muted"
                      onClick={() => onSelect(full)}
                      title={gif.title || "GIF"}
                    >
                      <img
                        src={thumb}
                        alt={gif.title || "GIF"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    <GifCategoryMenu url={full} />
                    <button
                      className={cn(tileButtonClass, "right-1")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (fav) removeFavorite(full);
                        else addFavorite(full);
                      }}
                      title={fav ? "Remove from favorites" : "Add to favorites"}
                    >
                      <Star
                        className={cn(
                          "h-3.5 w-3.5",
                          fav ? "fill-yellow-400 text-warning" : "text-white"
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
            {loading && (
              <div className="flex justify-center py-3">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && gifs.length === 0 && (
              <div className="text-center text-xs text-muted-foreground py-8">
                {query ? "No GIFs found" : "No trending GIFs available"}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "favorites" && (
        <>
          {/* Categories */}
          <div className="flex items-center gap-1 border-b p-2">
            <div className="flex flex-1 items-center gap-1 overflow-x-auto">
              <button
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  activeCategory === null
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setCategoryId(null)}
              >
                All
              </button>
              {categories.map((c) =>
                editing === c.id ? (
                  <ChipInput
                    key={c.id}
                    initial={c.name}
                    onCommit={(name) => {
                      renameCategory(c.id, name);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <button
                    key={c.id}
                    className={cn(
                      "max-w-32 shrink-0 truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                      activeCategory?.id === c.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => setCategoryId(c.id)}
                    onDoubleClick={() => setEditing(c.id)}
                    title={`${c.name} (${c.urls.length})`}
                  >
                    {c.name}
                  </button>
                )
              )}
              {editing === "new" ? (
                <ChipInput
                  initial=""
                  onCommit={(name) => {
                    const id = createCategory(name);
                    if (id) setCategoryId(id);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  className="shrink-0 rounded-full border border-dashed border-border p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditing("new")}
                  title="New category"
                >
                  <Plus className="h-3 w-3" />
                </button>
              )}
            </div>
            {activeCategory && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground"
                    title="Category options"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                {/* Returning focus to the trigger would blur the rename field the moment it opened. */}
                <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <DropdownMenuItem onSelect={() => setEditing(activeCategory.id)}>
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      deleteCategory(activeCategory.id);
                      setCategoryId(null);
                    }}
                  >
                    Delete category
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: "380px" }}>
            {shownFavorites.length === 0 ? (
              <div className="text-center text-xs text-muted-foreground py-8 px-4">
                {activeCategory
                  ? "Nothing in this category yet. Use the folder on a GIF to add it here."
                  : "No favorite GIFs yet. Hover over a GIF and click the star to add it."}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1 p-2">
                {shownFavorites.map((url) => (
                  <div key={url} className="relative group">
                    <button
                      className="h-24 w-full overflow-hidden rounded-md border border-border hover:border-primary transition-colors cursor-pointer bg-muted"
                      onClick={() => onSelect(url)}
                      title="Send GIF"
                    >
                      <img
                        src={url}
                        alt="Favorite GIF"
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    <GifCategoryMenu url={url} />
                    <button
                      className={cn(tileButtonClass, "right-1")}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFavorite(url);
                      }}
                      title="Remove from favorites"
                    >
                      <Star className="h-3.5 w-3.5 fill-yellow-400 text-warning" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
