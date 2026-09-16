import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * drag/click/touch on progress or volume
 * ui stays live while youre dragging
 */
export function useScrubBar(duration: number, onSeek: (time: number) => void) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !duration) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const time = ratio * duration;
      setScrubTime(time);
      onSeek(time);
      return time;
    },
    [duration, onSeek]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!duration) return;
      scrubbingRef.current = true;
      setScrubbing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    },
    [duration, seekFromClientX]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbingRef.current) return;
      seekFromClientX(e.clientX);
    },
    [seekFromClientX]
  );

  const endScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  // pointer left the window mid-drag, drop it
  useEffect(() => {
    const cancel = () => {
      if (!scrubbingRef.current) return;
      scrubbingRef.current = false;
      setScrubbing(false);
    };
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  return { trackRef, scrubbing, scrubTime, onPointerDown, onPointerMove, onPointerUp: endScrub };
}
