/**
 * People's own fonts on their names (`name_font_url` on a profile).
 *
 * The server validates the URL on the way in (`valid_name_font_url`), but it
 * arrives here from the network, and on the web it lands in a stylesheet,
 * which is the sink that matters: a URL that closes the `url('…')` string is
 * not a broken font, it is arbitrary CSS running in every viewer's page.
 * Records written before the server checked are still in the database, so the
 * check is worth repeating rather than assuming, and every client repeats the
 * same one.
 *
 * Same rule as the server: same-origin, under `/external/`, and free of the
 * characters that end a CSS string or a rule.
 */
export function isSafeNameFontUrl(url: string | null | undefined): url is string {
  if (!url || url.length > 512) return false;
  if (/["'\\()<>{};]|\s/.test(url)) return false;
  const path = /^https?:\/\//i.test(url) ? url.slice(url.indexOf("/", 8)) : url;
  return path.startsWith("/external/") && !path.includes("..");
}
