import { useCallback, useMemo } from "react";
import { readableOn } from "@/lib/color";
import { useThemeSettings } from "./context";
import { resolveThemeColors } from "./themes";

/**
 * A converter from a colour someone chose to one readable on the theme in
 * force, for the colours Chatter draws that a person picked rather than the
 * theme: forum tags and role colours.
 *
 * It measures against both the page background and the card colour, since
 * these are drawn on both — a message on the background, a forum post on a
 * card — and a colour that clears one can sink into the other. 4.5:1 is text;
 * pass 3 for a border or other non-text mark.
 */
export function useReadableColor(): (color: string | undefined | null, minContrast?: number) => string {
  const { activeTheme } = useThemeSettings();
  const surfaces = useMemo(() => {
    const { background, card } = resolveThemeColors(activeTheme);
    return [background, card];
  }, [activeTheme]);
  return useCallback(
    (color, minContrast = 4.5) => (color ? readableOn(color, surfaces, minContrast) : ""),
    [surfaces],
  );
}
