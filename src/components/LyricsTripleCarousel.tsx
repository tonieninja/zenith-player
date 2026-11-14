import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { LyricKaraokeText } from './LyricKaraokeText';
import './LyricsTripleCarousel.css';

export const OVERLAY_LYRICS_SLIDE_MS = 780;
const SLIDE_EASE = 'cubic-bezier(0.33, 1, 0.45, 1)';

export type SyncedLyricLine = { time: number; text: string };

function scrollOffset(activeIdx: number, total: number): number {
  if (total <= 3) return 0;
  if (activeIdx <= 0) return 0;
  if (activeIdx >= total - 1) return total - 3;
  return activeIdx - 1;
}

type Props = {
  synced: SyncedLyricLine[];
  idx: number;
  className?: string;
  slideMs?: number;
  onLineClick?: (time: number) => void;
  getProgress?: () => number;
};

export const LyricsTripleCarousel = memo(function LyricsTripleCarousel({
  synced,
  idx,
  className = '',
  slideMs = OVERLAY_LYRICS_SLIDE_MS,
  onLineClick,
  getProgress,
}: Props) {
  const activeIdx = idx >= 0 ? idx : -1;
  const targetOffset = scrollOffset(activeIdx >= 0 ? activeIdx : 0, synced.length);
  const [offset, setOffset] = useState(targetOffset);
  const [sliding, setSliding] = useState(false);
  const trackKey = `${synced.length}:${synced[0]?.time ?? 0}`;
  const prevTargetRef = useRef(targetOffset);

  useLayoutEffect(() => {
    setOffset(targetOffset);
    setSliding(false);
    prevTargetRef.current = targetOffset;
  }, [trackKey]);

  useLayoutEffect(() => {
    if (targetOffset === prevTargetRef.current) return;
    prevTargetRef.current = targetOffset;
    setSliding(true);
    const id = requestAnimationFrame(() => setOffset(targetOffset));
    return () => cancelAnimationFrame(id);
  }, [targetOffset, trackKey]);

  useLayoutEffect(() => {
    if (!sliding) return;
    const id = window.setTimeout(() => setSliding(false), slideMs + 60);
    return () => window.clearTimeout(id);
  }, [sliding, slideMs, offset]);

  const renderLine = (line: SyncedLyricLine, i: number) => {
    let state = ' is-distant';
    if (activeIdx < 0 && i === 0) state = ' is-next';
    else if (i === activeIdx) state = ' is-active';
    else if (i === activeIdx + 1) state = ' is-next';
    else if (i === activeIdx - 1) state = ' is-past';

    const text = (
      <LyricKaraokeText
        text={line.text}
        active={state === ' is-active'}
        start={line.time}
        end={synced[i + 1]?.time ?? line.time + 4}
        getProgress={getProgress}
      />
    );
    if (onLineClick) {
      return (
        <button
          key={`${line.time}-${i}`}
          type="button"
          className={`lyric-row lyric-carousel-row${state}`}
          onClick={() => onLineClick(line.time)}
        >
          {text}
        </button>
      );
    }
    return (
      <div key={`${line.time}-${i}`} className={`lyric-row lyric-carousel-row${state}`}>
        {text}
      </div>
    );
  };

  return (
    <div
      className={`lyrics-triple-carousel ${className}${sliding ? ' is-sliding' : ''}`}
      style={
        {
          '--slide-ms': `${slideMs}ms`,
          '--slide-ease': SLIDE_EASE,
        } as CSSProperties
      }
    >
      <div className="lyrics-carousel-glow" aria-hidden />
      <div className="lyrics-carousel-viewport">
        <div
          className={`lyrics-carousel-track${sliding ? ' is-sliding' : ''}`}
          style={{ transform: `translate3d(0, calc(-1 * ${offset} * var(--slot-h)), 0)` }}
        >
          {synced.map((line, i) => renderLine(line, i))}
        </div>
      </div>
      <div className="lyrics-carousel-slot-markers" aria-hidden>
        <span className="slot-marker slot-past" />
        <span className="slot-marker slot-active" />
        <span className="slot-marker slot-next" />
      </div>
    </div>
  );
});
