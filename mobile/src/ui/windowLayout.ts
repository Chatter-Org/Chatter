import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { useFolds } from "../../modules/chatter-fold";

/**
 * The window's shape for laying the app out: its size, and the postures of a
 * foldable that the layout bends around.
 *
 * - `book`: a vertical hinge across the window (an unfolded Fold held
 *   upright). The panels split at the hinge rather than across it, so nothing
 *   sits in the crease.
 * - `tabletop`: a horizontal hinge, half open (a Fold propped like a laptop).
 *   The conversation goes on the top half, and typing on the bottom.
 */
export interface WindowLayout {
  width: number;
  height: number;
  book: { x: number; width: number } | null;
  tabletop: { y: number; height: number } | null;
}

/** A pane narrower than this either side of a hinge is not worth splitting for. */
const MIN_PANE = 280;

export function useWindowLayout(): WindowLayout {
  const { width, height } = useWindowDimensions();
  const folds = useFolds();
  return useMemo(() => {
    let book: WindowLayout["book"] = null;
    let tabletop: WindowLayout["tabletop"] = null;
    for (const fold of folds) {
      if (fold.orientation === "vertical" && fold.x >= MIN_PANE && width - (fold.x + fold.width) >= MIN_PANE) {
        book = { x: fold.x, width: fold.width };
      }
      if (fold.orientation === "horizontal" && fold.state === "halfOpened" && fold.y >= 200 && height - (fold.y + fold.height) >= 160) {
        tabletop = { y: fold.y, height: fold.height };
      }
    }
    return { width, height, book, tabletop };
  }, [folds, width, height]);
}

/** The widest a screen of reading and forms gets (settings, a post). */
export const READING_WIDTH = 760;

/**
 * Side padding that keeps a pushed screen to a readable column on a wide
 * window — a tablet, a foldable open in landscape — and nothing on a phone.
 */
export function useReadingColumn(): { paddingHorizontal: number } | null {
  const { width } = useWindowDimensions();
  const side = Math.floor((width - READING_WIDTH) / 2);
  return side >= 48 ? { paddingHorizontal: side } : null;
}
