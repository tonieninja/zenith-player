import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { LyricKaraokeText } from './LyricKaraokeText';
import { LyricsTripleCarousel } from './LyricsTripleCarousel';
import './SyncedLyricsRail.css';

export const SYNCED_LYRICS_SLIDE_MS = 520;
export { OVERLAY_LYRICS_SLIDE_MS } from './LyricsTripleCarousel';

const SLIDE_EASE = (t: number) => 1 - (1 - t) ** 3;

function smoothScrollToCenter(container: HTMLElement, target: HTMLElement, duration: number) {
  const start = container.scrollTop;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const idealDelta =
    targetRect.top - containerRect.top - (containerRect.height - targetRect.height) / 2;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const end = Math.max(0, Math.min(start + idealDelta, maxScroll));
  const delta = end - start;
  if (Math.abs(delta) < 1) return;

  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    container.scrollTop = start + (end - start) * SLIDE_EASE(p);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export type SyncedLyricLine = { time: number; text: string };

type Props = {
  synced: SyncedLyricLine[];
  idx: number;
  onLineClick?: (time: number) => void;
  className?: string;
  slideMs?: number;
  /** rail = overlay (now + next), full = whole scrollable player list */
  mode?: 'rail' | 'full';
  /** also show the line above, sloppy lrc/musixmatch is a thing */
  showPrevious?: boolean;
  /** currentTime in seconds, drives the left-to-right karaoke fill */
  getProgress?: () => number;
};

export const SyncedLyricsRail = memo(function SyncedLyricsRail({
  synced,
  idx,
  onLineClick,
  className = '',
  slideMs = SYNCED_LYRICS_SLIDE_MS,
  mode = 'rail',
  showPrevious = false,
  getProgress,
}: Props) {
  const displayIdx = idx;
  const [renderIdx, setRenderIdx] = useState(displayIdx);
  const [sliding, setSliding] = useState(false);
  const activeLineRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const trackKey = `${synced.length}:${synced[0]?.time ?? 0}`;

  useLayoutEffect(() => {
    setRenderIdx(displayIdx);
    setSliding(false);
    if (mode === 'full') listRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [trackKey, mode]);

  useLayoutEffect(() => {
    if (displayIdx === renderIdx) return;
    setSliding(true);
    const id = requestAnimationFrame(() => setRenderIdx(displayIdx));
    return () => cancelAnimationFrame(id);
  }, [displayIdx, renderIdx, trackKey]);

  useLayoutEffect(() => {
    if (!sliding) return;
    const id = window.setTimeout(() => setSliding(false), slideMs + 180);
    return () => window.clearTimeout(id);
  }, [sliding, slideMs]);

  useLayoutEffect(() => {
    if (mode !== 'full' || renderIdx < 0) return;
    const list = listRef.current;
    const line = activeLineRef.current;
    if (!list || !line) return;
    smoothScrollToCenter(list, line, slideMs);
  }, [renderIdx, trackKey, mode, slideMs]);

  if (!synced.length) return null;

  if (mode === 'full') {
    const WINDOW = 36;
    const start = Math.max(0, renderIdx - WINDOW);
    const end = Math.min(synced.length, renderIdx + WINDOW + 1);
    const visible = synced.slice(start, end);
    return (
      <div
        className={`synced-lyrics-rail synced-lyrics-rail--full${sliding ? ' is-sliding' : ''} ${className}`.trim()}
        style={{ '--slide-ms': `${slideMs}ms` } as CSSProperties}
      >
        <div className="synced-lyrics-full-list" ref={listRef}>
          {visible.map((line, vi) => {
            const i = start + vi;
            let state = ' is-upcoming';
            if (i === renderIdx && renderIdx >= 0) state = ' is-active';
            else if (renderIdx >= 0 && i === renderIdx + 1) state = ' is-next';
            else if (renderIdx >= 0 && i < renderIdx) state = ' is-past';
            const activeRef = (el: HTMLButtonElement | HTMLDivElement | null) => {
              if (i === renderIdx) activeLineRef.current = el;
            };
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
                  ref={activeRef}
                  type="button"
                  className={`lyric-row${state}`}
                  onClick={() => onLineClick(line.time)}
                >
                  {text}
                </button>
              );
            }
            return (
              <div key={`${line.time}-${i}`} ref={activeRef} className={`lyric-row${state}`}>
                {text}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (showPrevious) {
    return (
      <LyricsTripleCarousel
        synced={synced}
        idx={idx}
        className={className}
        onLineClick={onLineClick}
        getProgress={getProgress}
      />
    );
  }

  const railClass = ['synced-lyrics-rail', className].filter(Boolean).join(' ');

  return (
    <div className={railClass} style={{ '--slide-ms': `${slideMs}ms` } as CSSProperties}>
      <div
        className="synced-lyrics-viewport"
        onTransitionEnd={(e) => {
          if (e.propertyName === 'transform') setSliding(false);
        }}
      >
        <div
          className={`synced-lyrics-track${sliding ? ' is-sliding' : ''}`}
          style={{
            transform: `translate3d(0, calc(-1 * ${Math.max(0, renderIdx)} * var(--lyric-row-h)), 0)`,
          }}
        >
          {synced.map((line, i) => {
            let state = ' is-upcoming';
            if (renderIdx >= 0 && i === renderIdx) state = ' is-active';
            else if (renderIdx >= 0 && i === renderIdx + 1) state = ' is-next';
            else if (renderIdx >= 0 && i < renderIdx) state = ' is-past';
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
                  className={`lyric-row${state}`}
                  onClick={() => onLineClick(line.time)}
                >
                  {text}
                </button>
              );
            }
            return (
              <div key={`${line.time}-${i}`} className={`lyric-row${state}`}>
                {text}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
