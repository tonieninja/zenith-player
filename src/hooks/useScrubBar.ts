import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatest } from './useLatest';

// w trakcie ciągnięcia tylko podgląd; seek dopiero po puszczeniu, bo w silniku natywnym to często nowe żądanie HTTP
export function useScrubBar(
  duration: number,
  onSeek: (time: number) => void,
  onScrub: (time: number) => void
) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const pendingRef = useRef<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const preview = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !duration) return;
      const rect = el.getBoundingClientRect();
      const time = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
      pendingRef.current = time;
      onScrub(time);
    },
    [duration, onScrub]
  );

  const finish = useCallback(
    (commit: boolean) => {
      if (!scrubbingRef.current) return;
      scrubbingRef.current = false;
      setScrubbing(false);
      const time = pendingRef.current;
      pendingRef.current = null;
      if (commit && time != null) onSeek(time);
    },
    [onSeek]
  );
  const finishRef = useLatest(finish);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!duration) return;
      scrubbingRef.current = true;
      setScrubbing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      preview(e.clientX);
    },
    [duration, preview]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (scrubbingRef.current) preview(e.clientX);
    },
    [preview]
  );

  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    release(e);
    finish(true);
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    release(e);
    finish(false);
  };

  useEffect(() => {
    const up = () => finishRef.current(true);
    const cancel = () => finishRef.current(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [finishRef]);

  return { trackRef, scrubbing, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
