import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { LyricKaraokeText } from './LyricKaraokeText';
import { lyricLineEnd } from '../lyrics/active';
import { useLightLyrics } from '../lyrics/light';
import { useLyricsExtras } from '../lyrics/extras';
import './SyncedLyricsRail.css';

const SYNCED_LYRICS_SLIDE_MS = 600;

// ta sama krzywa co --slide-ease w CSS, natywne scrollTo smooth ma własny czas i rozjeżdża się z wierszami
const SLIDE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const scrollAnim = new WeakMap<HTMLElement, Animation>();

// scrollTop od razu, treść dojeżdża transformacją w kompozytorze; pętla scrollTop budziła wątek co klatkę
function smoothScrollToCenter(
  container: HTMLElement,
  track: HTMLElement,
  target: HTMLElement,
  duration: number
) {
  const running = scrollAnim.get(container);
  const shown = running ? new DOMMatrixReadOnly(getComputedStyle(track).transform).m42 : 0;
  running?.cancel();
  scrollAnim.delete(container);
  const visual = container.scrollTop - shown;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const idealDelta =
    targetRect.top - containerRect.top - (containerRect.height - targetRect.height) / 2;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const end = Math.max(0, Math.min(container.scrollTop + idealDelta, maxScroll));
  container.scrollTop = end;
  const from = end - visual;
  // systemowe „ogranicz ruch”: tekst przeskakuje od razu, bez dojazdu
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (still || Math.abs(from) < 1 || typeof track.animate !== 'function') return;
  scrollAnim.set(
    container,
    track.animate([{ transform: `translate3d(0, ${from}px, 0)` }, { transform: 'none' }], {
      duration,
      easing: SLIDE_EASE,
    })
  );
}

export type SyncedLyricLine = { time: number; text: string };

type Props = {
  synced: SyncedLyricLine[];
  idx: number;
  onLineClick?: (time: number) => void;
  className?: string;
  slideMs?: number;
  getProgress?: () => number;
  translateTo?: string;
};

const WINDOW = 36;

export const SyncedLyricsRail = memo(function SyncedLyricsRail({
  synced,
  idx,
  onLineClick,
  className = '',
  slideMs = SYNCED_LYRICS_SLIDE_MS,
  getProgress,
  translateTo = 'en',
}: Props) {
  const light = useLightLyrics();
  const extras = useLyricsExtras(
    synced.map((l) => l.text),
    translateTo
  );
  const activeLineRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const trackKey = `${synced.length}:${synced[0]?.time ?? 0}`;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    scrollAnim.get(list)?.cancel();
    list.scrollTo({ top: 0, behavior: 'auto' });
  }, [trackKey]);

  useLayoutEffect(() => {
    if (idx < 0) return;
    const list = listRef.current;
    const line = activeLineRef.current;
    const track = trackRef.current;
    if (!list || !line || !track) return;
    smoothScrollToCenter(list, track, line, slideMs);
  }, [idx, trackKey, slideMs]);

  if (!synced.length) return null;

  const visible = synced.slice(0, Math.min(synced.length, idx + WINDOW + 1));
  return (
    <div
      className={`synced-lyrics-rail${light ? ' synced-lyrics-rail--light' : ''} ${className}`.trim()}
      style={{ '--slide-ms': `${slideMs}ms` } as CSSProperties}
    >
      <div className="synced-lyrics-full-list" ref={listRef}>
        <div className="synced-lyrics-track" ref={trackRef}>
          {visible.map((line, i) => {
            let state = ' is-upcoming';
            if (i === idx) state = ' is-active';
            else if (idx >= 0 && i === idx + 1) state = ' is-next';
            else if (i < idx) state = ' is-past';
            const activeRef = (el: HTMLButtonElement | HTMLDivElement | null) => {
              if (i === idx) activeLineRef.current = el;
            };
            const karaoke = (t: string) => (
              <LyricKaraokeText
                text={t}
                active={state === ' is-active'}
                start={line.time}
                end={lyricLineEnd(synced, i)}
                getProgress={getProgress}
              />
            );
            const { roman, trans } = extras[i] ?? {};
            const text =
              roman || trans ? (
                <span className="lyric-row-stack">
                  {karaoke(line.text)}
                  {roman && <span className="lyric-row-sub lyric-row-roman">{karaoke(roman)}</span>}
                  {trans && <span className="lyric-row-sub lyric-row-trans">{trans}</span>}
                </span>
              ) : (
                karaoke(line.text)
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
    </div>
  );
});
