import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { LyricKaraokeText } from './LyricKaraokeText';
import { useLightLyrics } from '../lyrics/light';
import './SyncedLyricsRail.css';

const SYNCED_LYRICS_SLIDE_MS = 600;

// ta sama krzywa co --slide-ease w CSS, natywne scrollTo smooth ma własny czas i rozjeżdża się z wierszami
const SLIDE_EASE = (t: number) => 1 - (1 - t) ** 5;
const scrollRaf = new WeakMap<HTMLElement, number>();

function smoothScrollToCenter(container: HTMLElement, target: HTMLElement, duration: number) {
  cancelAnimationFrame(scrollRaf.get(container) ?? 0);
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
    container.scrollTop = start + delta * SLIDE_EASE(p);
    if (p < 1) scrollRaf.set(container, requestAnimationFrame(tick));
  };
  scrollRaf.set(container, requestAnimationFrame(tick));
}

export type SyncedLyricLine = { time: number; text: string };

type Props = {
  synced: SyncedLyricLine[];
  idx: number;
  onLineClick?: (time: number) => void;
  className?: string;
  slideMs?: number;
  getProgress?: () => number;
};

const WINDOW = 36;

export const SyncedLyricsRail = memo(function SyncedLyricsRail({
  synced,
  idx,
  onLineClick,
  className = '',
  slideMs = SYNCED_LYRICS_SLIDE_MS,
  getProgress,
}: Props) {
  const light = useLightLyrics();
  const activeLineRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const trackKey = `${synced.length}:${synced[0]?.time ?? 0}`;

  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [trackKey]);

  useLayoutEffect(() => {
    if (idx < 0) return;
    const list = listRef.current;
    const line = activeLineRef.current;
    if (!list || !line) return;
    smoothScrollToCenter(list, line, slideMs);
  }, [idx, trackKey, slideMs]);

  if (!synced.length) return null;

  const visible = synced.slice(0, Math.min(synced.length, idx + WINDOW + 1));
  return (
    <div
      className={`synced-lyrics-rail${light ? ' synced-lyrics-rail--light' : ''} ${className}`.trim()}
      style={{ '--slide-ms': `${slideMs}ms` } as CSSProperties}
    >
      <div className="synced-lyrics-full-list" ref={listRef}>
        {visible.map((line, i) => {
          let state = ' is-upcoming';
          if (i === idx) state = ' is-active';
          else if (idx >= 0 && i === idx + 1) state = ' is-next';
          else if (i < idx) state = ' is-past';
          const activeRef = (el: HTMLButtonElement | HTMLDivElement | null) => {
            if (i === idx) activeLineRef.current = el;
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
});
