import { serverAsset, sessionHeaders } from "@/platform/server";

/**
 * An image source for something the server holds.
 *
 * A server can require sign-in for its uploads, so the session goes along as a
 * header to it (and only to it) (the web fetches these as blobs for the same reason). The cache key
 * is the URL alone: the token changes every quarter of an hour, and a picture
 * must not be fetched again because of it.
 */
export function serverImage(path: string | null | undefined) {
  const uri = serverAsset(path);
  if (!uri) return undefined;
  return { uri, cacheKey: uri, headers: sessionHeaders(uri) };
}
