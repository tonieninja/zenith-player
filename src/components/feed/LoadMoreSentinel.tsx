import { useEffect, useRef } from 'react';

/** Woła onVisible, gdy koniec listy jest bliżej niż 800 px; zmiana tick sprawdza to od nowa. */
export function LoadMoreSentinel({ onVisible, tick }: { onVisible: () => void; tick: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    // listę przewija kontener, a nie okno, więc margines musi dotyczyć jego krawędzi
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisible();
      },
      { root: el.closest('.content-scrollable'), rootMargin: '0px 0px 800px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, tick]);
  return <div ref={ref} className="feed-load-sentinel" aria-hidden />;
}
