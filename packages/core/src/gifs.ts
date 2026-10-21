/**
 * A GIF from the server's search (`/api/gifs`), which passes its provider's
 * sizes through. The picker shows the small one and sends the medium one.
 */
export interface GifItem {
  title?: string;
  file?: {
    xs?: { gif?: { url?: string } };
    sm?: { gif?: { url?: string } };
    md?: { gif?: { url?: string } };
    gif?: { url?: string };
  };
}

export function gifThumbUrl(gif: GifItem): string | undefined {
  return gif.file?.sm?.gif?.url || gif.file?.xs?.gif?.url || gif.file?.gif?.url;
}

export function gifFullUrl(gif: GifItem): string | undefined {
  return gif.file?.md?.gif?.url || gif.file?.gif?.url || gifThumbUrl(gif);
}

/** A page of search results, and whether there is another. */
export function gifPage(response: unknown): { items: GifItem[]; hasNext: boolean } {
  const data = (response as { data?: { data?: GifItem[]; has_next?: boolean } } | null)?.data;
  return { items: data?.data ?? [], hasNext: data?.has_next ?? false };
}

/** Whether a URL is a GIF (which can be favourited from a message). */
export const isGifUrl = (url: string) => /\.gif(\?.*)?$/i.test(url);
