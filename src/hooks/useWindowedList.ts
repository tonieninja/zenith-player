import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Windowing for long uniform lists (library sections, queue). Below `threshold` items it
 * is a no-op and the list renders exactly as before. Above it only the rows around the
 * viewport are mounted and two spacer divs keep the scroll height identical, so the look
 * and the scroll position do not change. Row stride (height + gap) is measured from the
 * rendered rows, so CSS / media queries stay the single source of truth.
 * Costs nothing while idle: work happens only in scroll/resize events (rAF-coalesced).
 */
export const WINDOW_THRESHOLD = 150;
const OVERSCAN = 12;
const INITIAL_ROWS = 40;

export type WindowedList = {
  enabled: boolean;
  start: number;
  end: number;
  /** spacer heights in px (0 = do not render the spacer) */
  padTop: number;
  padBottom: number;
  listRef: (el: HTMLElement | null) => void;
};

function findScroller(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

export function useWindowedList(
  count: number,
  opts: { threshold?: number; scrollSelf?: boolean } = {}
): WindowedList {
  const threshold = opts.threshold ?? WINDOW_THRESHOLD;
  const enabled = count > threshold;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(count, INITIAL_ROWS)]);
  // stride = distance between two row tops, gap = stride - row height (flex gap)
  const metrics = useRef<{ stride: number; gap: number }>({ stride: 0, gap: 0 });
  const [, setMeasured] = useState(0);
  const raf = useRef(0);

  const measure = useCallback(() => {
    if (!el) return false;
    const rows: HTMLElement[] = [];
    for (const c of Array.from(el.children) as HTMLElement[]) {
      if (!c.hasAttribute('data-vspacer')) rows.push(c);
    }
    if (rows.length < 2) return false;
    const a = rows[0];
    const b = rows[rows.length - 1];
    const stride = (b.offsetTop - a.offsetTop) / (rows.length - 1);
    if (!(stride > 0)) return false;
    const gap = Math.max(0, stride - a.offsetHeight);
    const m = metrics.current;
    if (Math.abs(m.stride - stride) > 0.01 || Math.abs(m.gap - gap) > 0.01) {
      metrics.current = { stride, gap };
      setMeasured((n) => n + 1);
    }
    return true;
  }, [el]);

  const update = useCallback(() => {
    raf.current = 0;
    if (!el || !enabled) return;
    if (!metrics.current.stride && !measure()) return;
    const scroller = opts.scrollSelf ? el : findScroller(el);
    if (!scroller) return;
    const { stride } = metrics.current;
    const firstRowOffset = parseFloat(getComputedStyle(el).paddingTop) || 0;
    // how far the viewport top is below row 0's top
    const viewTop =
      scroller === el
        ? el.scrollTop - firstRowOffset
        : scroller.getBoundingClientRect().top - el.getBoundingClientRect().top - firstRowOffset;
    const viewBottom = viewTop + scroller.clientHeight;
    const s = Math.max(0, Math.floor(viewTop / stride) - OVERSCAN);
    const e = Math.min(count, Math.max(s + 1, Math.ceil(viewBottom / stride) + OVERSCAN));
    setRange((r) => (r[0] === s && r[1] === e ? r : [s, e]));
  }, [el, enabled, count, measure, opts.scrollSelf]);

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(update);
  }, [update]);

  useEffect(() => {
    if (!el || !enabled) return;
    const scroller = opts.scrollSelf ? el : findScroller(el);
    const target: HTMLElement | Window = scroller || window;
    target.addEventListener('scroll', schedule, { passive: true });
    // row height can change with media queries / fonts, and a list mounted while hidden
    // gets its first real size later: re-measure whenever the list or scroller resizes
    const ro = new ResizeObserver(() => {
      metrics.current.stride = 0;
      schedule();
    });
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    schedule();
    return () => {
      target.removeEventListener('scroll', schedule);
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [el, enabled, schedule, opts.scrollSelf]);

  // first measurement before paint, so the spacers are there in the very first frame
  useLayoutEffect(() => {
    if (el && enabled) update();
  }, [el, enabled, update]);

  // count changed (items added/removed): clamp and recompute
  useLayoutEffect(() => {
    if (!enabled) return;
    setRange((r) => {
      const e = Math.min(count, Math.max(r[1], Math.min(count, INITIAL_ROWS)));
      const s = Math.min(r[0], Math.max(0, e - 1));
      return r[0] === s && r[1] === e ? r : [s, e];
    });
    schedule();
  }, [count, enabled, schedule]);

  if (!enabled) {
    return { enabled, start: 0, end: count, padTop: 0, padBottom: 0, listRef: setEl };
  }
  const [start, end] = range;
  const { stride, gap } = metrics.current;
  // before the first measurement there is no spacer; rows 0..INITIAL_ROWS render normally
  const st = stride || 0;
  const padTop = start > 0 && st ? start * st - gap : 0;
  const padBottom = end < count && st ? (count - end) * st - gap : 0;
  return {
    enabled,
    start,
    end: st ? end : Math.min(end, count),
    padTop,
    padBottom,
    listRef: setEl,
  };
}
