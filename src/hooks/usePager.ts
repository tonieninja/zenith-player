import { useCallback, useEffect, useRef, useState } from 'react';

export function usePager<T>(items: T[], pageSize: number) {
  const [start, setStart] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [dir, setDir] = useState<'left' | 'right' | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const total = items.length;
  const canPrev = start > 0;
  const canNext = start + pageSize < total;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setStart((s) => Math.max(0, Math.min(s, Math.max(0, total - pageSize))));
  }, [total, pageSize]);

  const go = useCallback(
    (delta: 1 | -1) => {
      setStart((s) => Math.max(0, Math.min(s + delta, Math.max(0, total - pageSize))));
      setDir(delta === 1 ? 'left' : 'right');
      setEpoch((e) => e + 1);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setDir(null), 420);
    },
    [total, pageSize]
  );

  const prev = useCallback(() => {
    if (start > 0) go(-1);
  }, [start, go]);

  const next = useCallback(() => {
    if (start + pageSize < total) go(1);
  }, [start, pageSize, total, go]);

  return {
    start,
    visible: items.slice(start, start + pageSize),
    canPrev,
    canNext,
    prev,
    next,
    dir,
    epoch,
  };
}
