import { useEffect, useRef, useState } from 'react';

export function useResponsivePageSize<T extends HTMLElement = HTMLElement>(
  cardWidth: number,
  max: number,
  min = 2
) {
  const ref = useRef<T | null>(null);
  const [pageSize, setPageSize] = useState(max);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = (width: number) => {
      const fit = Math.floor(width / cardWidth);
      setPageSize(Math.max(min, Math.min(max, fit || min)));
    };
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? 0;
      // minimized windows report width 0, ignore or we get a resize storm
      // zminimalizowane okno klamie ze ma 0px, nie dawaj sie nabrac
      if (width < 48) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure(width);
      });
    });
    ro.observe(el);
    measure(el.getBoundingClientRect().width);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cardWidth, max, min]);

  return { ref, pageSize };
}
