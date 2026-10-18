import { getAccessToken } from "@chatter/core/api";
import { serverAsset } from "@/platform/server";

/**
 * An image source for something the server holds.
 *
 * A server can require sign-in for its uploads, so the session goes along as a
 * header (the web fetches these as blobs for the same reason). The cache key
 * is the URL alone: the token changes every quarter of an hour, and a picture
 * must not be fetched again because of it.
 */
export function serverImage(path: string | null | undefined) {
  const uri = serverAsset(path);
  if (!uri) return undefined;
  const token = getAccessToken();
  return {
    uri,
    cacheKey: uri,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  };
}
