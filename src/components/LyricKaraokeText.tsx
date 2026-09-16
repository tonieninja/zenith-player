import { useEffect, useRef } from 'react';

type Props = {
  text: string;
  active: boolean;
  start: number;
  end: number;
  getProgress?: () => number;
};

export function LyricKaraokeText({ text, active, start, end, getProgress }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = wrapRef.current;
    if (!el) return;
    const span = Math.max(0.32, end - start);
    let raf = 0;
    const tick = () => {
      // karaoke wipe should start with the highlight, same late-bias as the active line
      // z lewej do prawej jak karaoke na weselu, tylko mniej wstydu
      const t = (getProgress?.() ?? start) - 0.35;
      const p = Math.max(0, Math.min(1, (t - start) / span));
      el.style.setProperty('--karaoke-p', `${(p * 100).toFixed(2)}%`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, start, end, getProgress]);

  if (!active) {
    return <span className="lyric-row-text">{text}</span>;
  }

  return (
    <span className="lyric-row-text lyric-karaoke" ref={wrapRef}>
      <span className="lyric-karaoke-base">{text}</span>
      <span className="lyric-karaoke-fill" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
