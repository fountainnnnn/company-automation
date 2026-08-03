import { useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Live pixel width of an element. Charts draw in real pixels rather than a
 * scaled viewBox, so their type and hairlines never stretch.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
