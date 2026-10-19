import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Check, Folder, Plus, Search, Star, Trash2 } from "lucide-react-native";
import { apiSearchGifs } from "@chatter/core/api";
import { gifFullUrl, gifPage, gifThumbUrl, type GifItem } from "@chatter/core/gifs";
import {
  MAX_CATEGORY_NAME,
  getGifFavorites,
  gifFavoriteActions,
  loadGifFavorites,
  subscribeGifFavorites,
} from "@chatter/core/gifFavorites";
import { useDevicePrefs } from "@/state/devicePrefs";
import { useTheme } from "@/theme/ThemeProvider";
import { Sheet, SheetRow, useSheetWidth } from "@/ui/Sheet";
import { Segmented } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING, UI_HINT } from "@/ui/roles";
import { TextField } from "@/ui/settings";

const PER_PAGE = 24;

export function useGifFavorites() {
  const { favorites, categories } = useSyncExternalStore(subscribeGifFavorites, getGifFavorites);
  return { favorites, categories, ...gifFavoriteActions, isFavorite: (url: string) => favorites.includes(url) };
}

/**
 * GIFs — the web's GifPicker as a sheet: search (trending until you type),
 * and your favourites with their categories, kept on the account. Tap one to
 * put it in the message; hold one to favourite it or file it; hold a category
 * to rename or delete it.
 */
export function GifPickerSheet({ open, onClose, onPick }: { open: boolean; onClose(): void; onPick(url: string): void }) {
  const { height } = useWindowDimensions();
  const width = useSheetWidth();
  // Three abreast however few there are: px-3 either side, gap-1 between.
  const tile = Math.floor((width - 24 - 8) / 3);
  const { colors } = useTheme();
  const [tab, setTab] = useState<"search" | "favorites">("search");
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<{ thumb: string; full: string; title?: string }[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const fav = useGifFavorites();
  const request = useRef(0);

  const fetchGifs = useCallback(async (q: string, p: number, append: boolean) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const { items, hasNext } = gifPage(await apiSearchGifs(q, p, PER_PAGE));
      if (id !== request.current) return;
      const rows: { thumb: string; full: string; title?: string }[] = [];
      for (const g of items as GifItem[]) {
        const thumb = gifThumbUrl(g);
        const full = gifFullUrl(g);
        if (thumb && full) rows.push({ thumb, full, title: g.title });
      }
      setGifs((prev) => (append ? [...prev, ...rows] : rows));
      setHasMore(hasNext);
    } catch {
      if (!append) setGifs([]);
      setHasMore(false);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  // Opening is when favourites matter: check they are current rather than
  // trust a socket that may have missed a change.
  useEffect(() => {
    if (open) void loadGifFavorites();
  }, [open]);

  // Trending at first, then a search a beat after typing stops.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setPage(1);
      setHasMore(true);
      void fetchGifs(query, 1, false);
    }, query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [open, query, fetchGifs]);

  const activeCategory = fav.categories.find((c) => c.id === categoryId) ?? null;
  const shown = tab === "search" ? gifs.map((g) => g.full) : activeCategory ? activeCategory.urls : fav.favorites;
  const thumbs = new Map(gifs.map((g) => [g.full, g.thumb]));

  const pick = (url: string) => {
    onPick(url);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="GIFs">
      <View style={{ height: height * 0.62 }}>
        <View className="gap-2 px-3 pb-2">
          <Segmented
            value={tab}
            options={[
              { value: "search", label: "Search" },
              { value: "favorites", label: fav.favorites.length > 0 ? `Favorites (${fav.favorites.length})` : "Favorites" },
            ]}
            onChange={(v) => setTab(v === "favorites" ? "favorites" : "search")}
          />
          {tab === "search" ? (
            <View className="flex-row items-center rounded-md border border-input pl-2.5">
              <Icon as={Search} size={15} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search GIFs..."
                placeholderTextColor={colors["muted-foreground"]}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                className="h-9 flex-1 px-2 font-mono text-sm text-foreground"
              />
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-1">
              <Chip label="All" on={activeCategory === null} onPress={() => setCategoryId(null)} />
              {fav.categories.map((c) => (
                <Chip key={c.id} label={c.name} on={activeCategory?.id === c.id} onPress={() => setCategoryId(c.id)} onLongPress={() => setEditingCategory(c.id)} />
              ))}
            </ScrollView>
          )}
        </View>

        <FlatList
          data={shown}
          keyExtractor={(url, i) => `${url}-${i}`}
          numColumns={3}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          columnWrapperClassName="gap-1"
          contentContainerClassName="gap-1 px-3 pb-3"
          onEndReached={() => {
            if (tab !== "search" || loading || !hasMore) return;
            const next = page + 1;
            setPage(next);
            void fetchGifs(query, next, true);
          }}
          onEndReachedThreshold={0.6}
          ListEmptyComponent={
            loading ? undefined : (
              <T className={cn(UI_HINT, "px-4 py-8 text-center")}>
                {tab === "search"
                  ? query
                    ? "No GIFs found"
                    : "No trending GIFs available"
                  : activeCategory
                    ? "Nothing in this category yet. Hold a GIF to file it here."
                    : "No favorite GIFs yet. Hold a GIF to add it."}
              </T>
            )
          }
          ListFooterComponent={loading ? <ActivityIndicator className="py-3" /> : undefined}
          renderItem={({ item }) => (
            <GifTile
              size={tile}
              url={thumbs.get(item) ?? item}
              favorite={fav.isFavorite(item)}
              onPress={() => pick(item)}
              onLongPress={() => setHolding(item)}
            />
          )}
        />
      </View>

      <GifActions url={holding} onClose={() => setHolding(null)} />
      <CategoryActions id={editingCategory} onClose={() => setEditingCategory(null)} />
    </Sheet>
  );
}

function Chip({ label, on, onPress, onLongPress }: { label: string; on: boolean; onPress(): void; onLongPress?(): void }) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      className={cn("rounded-full border px-2.5 py-1", on ? "border-primary bg-primary" : "border-border active:bg-accent")}
    >
      <T className={cn("text-xs", on ? "text-primary-foreground" : "text-muted-foreground")} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

function GifTile({ size, url, favorite, onPress, onLongPress }: { size: number; url: string; favorite: boolean; onPress(): void; onLongPress(): void }) {
  const { autoplayAnimated } = useDevicePrefs();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel="GIF"
      accessibilityHint="Puts it in your message; hold for favourites"
      style={{ width: size, height: size }}
      className="overflow-hidden rounded-md border border-border bg-muted active:border-primary"
    >
      <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} contentFit="cover" autoplay={autoplayAnimated} recyclingKey={url} />
      {favorite ? (
        <View className="absolute right-1 top-1 rounded-sm bg-black/50 p-0.5">
          <Star size={12} color="#facc15" fill="#facc15" />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Holding a GIF: favourite it, and file it into categories (or a new one). */
export function GifActions({ url, onClose }: { url: string | null; onClose(): void }) {
  const fav = useGifFavorites();
  const [newName, setNewName] = useState("");
  const isFav = !!url && fav.isFavorite(url);
  return (
    <Sheet open={!!url} onClose={onClose} title="GIF">
      {url ? (
      <View className="pb-2">
        <SheetRow
          icon={Star}
          label={isFav ? "Remove from favorites" : "Add to favorites"}
          onPress={() => {
            if (isFav) fav.removeFavorite(url);
            else fav.addFavorite(url);
            onClose();
          }}
        />
        <T className={cn(UI_HEADING, "px-4 pb-1 pt-3")}>Categories</T>
        {fav.categories.map((c) => {
          const inIt = c.urls.includes(url);
          return (
            <Pressable
              key={c.id}
              onPress={() => fav.setInCategory(c.id, url, !inIt)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: inIt }}
              className="flex-row items-center gap-3 px-4 py-2.5 active:bg-accent"
            >
              <Icon as={Folder} size={16} tone="foreground" />
              <T className="flex-1 text-sm" numberOfLines={1}>
                {c.name}
              </T>
              {inIt ? <Icon as={Check} size={15} tone="foreground" /> : null}
            </Pressable>
          );
        })}
        <View className="flex-row items-center gap-2 px-4 pt-2">
          <TextField
            className="h-9 flex-1"
            value={newName}
            onChangeText={setNewName}
            maxLength={MAX_CATEGORY_NAME}
            placeholder="New category…"
            onSubmitEditing={() => {
              const id = fav.createCategory(newName);
              if (id) {
                fav.setInCategory(id, url, true);
                setNewName("");
              }
            }}
          />
          <Pressable
            disabled={!newName.trim()}
            onPress={() => {
              const id = fav.createCategory(newName);
              if (id) {
                fav.setInCategory(id, url, true);
                setNewName("");
              }
            }}
            accessibilityLabel="Create category"
            className={cn("size-9 items-center justify-center rounded-md border border-input", !newName.trim() && "opacity-40")}
          >
            <Icon as={Plus} size={16} />
          </Pressable>
        </View>
      </View>
      ) : null}
    </Sheet>
  );
}

/** The category on screen in Favorites: rename it or delete it. */
export function CategoryActions({ id, onClose }: { id: string | null; onClose(): void }) {
  const fav = useGifFavorites();
  const category = fav.categories.find((c) => c.id === id);
  const [name, setName] = useState(category?.name ?? "");
  // Another category, or this one renamed elsewhere, starts the field over.
  const [nameFor, setNameFor] = useState(category?.name);
  if (nameFor !== category?.name) {
    setNameFor(category?.name);
    setName(category?.name ?? "");
  }
  return (
    <Sheet open={!!category} onClose={onClose} title={category?.name}>
      {category ? (
        <View className="gap-2 px-4 pb-2">
          <TextField value={name} onChangeText={setName} maxLength={MAX_CATEGORY_NAME} onSubmitEditing={() => (fav.renameCategory(category.id, name), onClose())} />
          <SheetRow icon={Trash2} label="Delete category" destructive onPress={() => (fav.deleteCategory(category.id), onClose())} />
        </View>
      ) : null}
    </Sheet>
  );
}
