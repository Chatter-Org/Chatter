import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// How far the pointer travels before a press becomes a drag rather than a click.
const DRAG_THRESHOLD_PX = 5;

type Offset = { x: number; y: number };

/**
 * Lets a floating element be dragged around its offset parent. The offset is
 * a translate from wherever CSS puts the element, kept inside the parent, and
 * the click that ends a drag is swallowed so the element's own buttons only
 * fire on a real click. `enabled` false drops the transform, so the same
 * element can sit in normal layout.
 */
export function useDraggableThumb(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  // Matches what is on screen, which is what clamp measures against.
  useLayoutEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  const dragRef = useRef<{ id: number; startX: number; startY: number; from: Offset; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // The largest move each way that keeps the element inside its parent.
  const clamp = useCallback(
    (next: Offset): Offset => {
      const el = ref.current;
      const parent = el?.offsetParent as HTMLElement | null | undefined;
      if (!el || !parent) return next;
      const box = el.getBoundingClientRect();
      const bounds = parent.getBoundingClientRect();
      // Where the element would sit with no translate.
      const baseLeft = box.left - offsetRef.current.x;
      const baseTop = box.top - offsetRef.current.y;
      return {
        x: Math.min(Math.max(next.x, bounds.left - baseLeft), bounds.right - box.width - baseLeft),
        y: Math.min(Math.max(next.y, bounds.top - baseTop), bounds.bottom - box.height - baseTop),
      };
    },
    [ref],
  );

  // A narrower window or a closed panel can leave the element outside.
  useEffect(() => {
    if (!enabled) return;
    const parent = ref.current?.offsetParent;
    if (!parent) return;
    const refit = () => {
      const next = clamp(offsetRef.current);
      if (next.x !== offsetRef.current.x || next.y !== offsetRef.current.y) setOffset(next);
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [enabled, clamp, ref]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (!enabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, from: offsetRef.current, moved: false };
  }, [enabled]);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // Captured only once it is a drag: capturing on press would retarget
        // a plain click away from the buttons inside.
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setOffset(clamp({ x: drag.from.x + dx, y: drag.from.y + dy }));
    },
    [clamp],
  );

  const onPointerEnd = useCallback((e: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      suppressClickRef.current = true;
      // A drag released outside the element produces no click to swallow.
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  }, []);

  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const style: CSSProperties | undefined = enabled
    ? { transform: `translate(${offset.x}px, ${offset.y}px)`, touchAction: "none" }
    : undefined;

  return {
    style,
    handlers: enabled
      ? { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onClickCapture }
      : {},
  };
}
