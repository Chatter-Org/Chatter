import { useSyncExternalStore } from "react";
import { gifFavoriteActions, getGifFavorites, subscribeGifFavorites } from "@chatter/core/gifFavorites";

// The store itself is shared with the phone (packages/core/src/gifFavorites.ts).
export * from "@chatter/core/gifFavorites";

export function useFavoriteGifs() {
  const { favorites, categories } = useSyncExternalStore(subscribeGifFavorites, getGifFavorites);
  return {
    favorites,
    categories,
    ...gifFavoriteActions,
    isFavorite: (url: string) => favorites.includes(url),
  };
}
