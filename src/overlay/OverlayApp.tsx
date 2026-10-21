import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { LyricKaraokeText } from '../components/LyricKaraokeText';
import type { OverlayPayload } from './types';
import { getLyricsSyncOffset } from '../plugins/lyricsOverlay';
import { getActiveLyricIndex } from '../utils/activeLyric';
import { imgErr, isYouTubeVideoId } from '../utils/imgError';
import {
  AUX_STRINGS,
  closeThisWindow,
  currentWindowLabel,
  startWindowDrag,
  useAuxLang,
} from '../utils/auxWindow';
import { attachOverlayWindowFit } from './windowFit';
import './overlay.css';

const STORAGE_KEY = 'zenith_overlay_last';
const IS_SECOND_SCREEN = currentWindowLabel() === 'lyrics-second';

function OverlayChrome({ label }: { label: string }) {
  return (
    <div className="overlay-chrome" data-no-drag>
      <button
        type="button"
        className="overlay-close-btn"
        onClick={() => void closeThisWindow()}
        aria-label={label}
        title={label}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function lineScale(text: string): number {
  const len = text.length;
  if (len > 90) return 0.72;
  if (len > 60) return 0.82;
  if (len > 38) return 0.92;
  return 1;
}

function OverlayLines({
  synced,
  idx,
  getProgress,
}: {
  synced: { time: number; text: string }[];
  idx: number;
  getProgress: () => number;
}) {
  const cur = idx >= 0 ? synced[idx] : null;
  const prev = idx > 0 ? synced[idx - 1] : null;
  const next = synced[idx + 1] ?? null;
  return (
    <div className="ov-lines">
      <div className="ov-line ov-line--side ov-line--prev" aria-hidden>
        {prev?.text || '\u00a0'}
      </div>
      <div
        key={idx}
        className="ov-line ov-line--active"
        style={{ '--line-scale': lineScale(cur?.text ?? '') } as CSSProperties}
      >
        {cur?.text ? (
          <LyricKaraokeText
            text={cur.text}
            active
            start={cur.time}
            end={synced[idx + 1]?.time ?? cur.time + 4}
            getProgress={getProgress}
          />
        ) : (
          '\u266a'
        )}
      </div>
      <div className="ov-line ov-line--side ov-line--next" aria-hidden>
        {next?.text || '\u00a0'}
      </div>
    </div>
  );
}

function TrackMeta({ data }: { data: OverlayPayload }) {
  if (!data.title) return null;
  return (
    <div className="overlay-meta">
      {data.coverUrl && (
        <img
          src={data.coverUrl}
          alt=""
          className="overlay-cover"
          decoding="async"
          onError={imgErr}
          {...(isYouTubeVideoId(data.trackId) ? { 'data-video-id': data.trackId } : {})}
        />
      )}
      <div className="overlay-meta-text">
        <div className="overlay-track-title" title={data.title}>
          {data.title}
        </div>
        <div className="overlay-track-artist" title={data.artist}>
          {data.artist}
        </div>
      </div>
    </div>
  );
}

export default function OverlayApp() {
  const lang = useAuxLang();
  const s = AUX_STRINGS[lang];
  const [data, setData] = useState<OverlayPayload | null>(null);
  const clockRef = useRef({ progress: 0, at: 0, seen: 0, playing: false, rate: 1 });
  const [clockTick, setClockTick] = useState(0);
  const lastPersistKeyRef = useRef('');
  const [syncOffsetMs, setSyncOffsetMs] = useState(getLyricsSyncOffset);
  const fitCleanup = useRef<(() => void) | null>(null);
  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    fitCleanup.current?.();
    fitCleanup.current = null;
    if (node && !IS_SECOND_SCREEN) fitCleanup.current = attachOverlayWindowFit(node);
  }, []);
  useEffect(
    () => () => {
      fitCleanup.current?.();
      fitCleanup.current = null;
    },
    []
  );

  useEffect(() => {
    const onSync = () => setSyncOffsetMs(getLyricsSyncOffset());
    window.addEventListener('zenith-lyrics-sync-changed', onSync);
    return () => window.removeEventListener('zenith-lyrics-sync-changed', onSync);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlayPayload>('zenith-lyrics-overlay', (e) => {
      const p = e.payload;
      if (IS_SECOND_SCREEN !== Boolean(p.secondScreen)) return;
      const c = clockRef.current;
      const rate = p.rate && p.rate > 0 ? p.rate : 1;
      const at = performance.now();
      const guess = c.playing ? c.progress + ((at - c.at) / 1000) * c.rate : c.progress;
      c.seen = at;
      if (c.playing !== p.isPlaying || c.rate !== rate || Math.abs(guess - p.progress) > 0.3) {
        clockRef.current = { progress: p.progress, at, seen: at, playing: p.isPlaying, rate };
        setClockTick((n) => n + 1);
      }
      setData((prev) => {
        if (!prev) return p;
        const sameTrack =
          prev.title === p.title &&
          prev.artist === p.artist &&
          prev.synced?.length === p.synced?.length &&
          prev.activeLyricIndex === p.activeLyricIndex &&
          prev.highContrast === p.highContrast &&
          prev.fontSize === p.fontSize &&
          prev.align === p.align &&
          prev.secondScreen === p.secondScreen &&
          prev.hideTrackMeta === p.hideTrackMeta &&
          prev.opacity === p.opacity &&
          prev.syncOffsetMs === p.syncOffsetMs &&
          (prev.text?.length ?? 0) === (p.text?.length ?? 0) &&
          prev.coverUrl === p.coverUrl;
        if (sameTrack && prev.isPlaying === p.isPlaying) return prev;
        if (sameTrack) return { ...prev, isPlaying: p.isPlaying, progress: p.progress };
        return p;
      });

      const persistKey = `${p.title}|${p.artist}|${p.synced?.length ?? 0}`;
      if (persistKey !== lastPersistKeyRef.current) {
        lastPersistKeyRef.current = persistKey;
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              title: p.title,
              artist: p.artist,
              coverUrl: p.coverUrl,
              trackId: p.trackId,
              syncedLen: p.synced?.length ?? 0,
              text: p.text ? '[plain]' : null,
            })
          );
        } catch (err) {
          console.debug('OverlayApp', err);
        }
      }
    }).then((fn) => {
      unlisten = fn;
      void emit('zenith-overlay-ready', currentWindowLabel()).catch((err) =>
        console.debug('OverlayApp', err)
      );
    });
    return () => unlisten?.();
  }, []);

  const [idx, setIdx] = useState(-1);
  const progressNowRef = useRef<() => number>(() => 0);
  const getOverlayProgress = useCallback(() => progressNowRef.current(), []);

  useEffect(() => {
    if (!data?.synced?.length) {
      setIdx(-1);
      progressNowRef.current = () => data?.progress ?? 0;
      return;
    }
    const offset = data.syncOffsetMs ?? syncOffsetMs;
    const now = () => {
      const c = clockRef.current;
      if (!c.playing) return c.progress;
      const elapsed = Math.min(performance.now(), c.seen + 12000) - c.at;
      return c.progress + (Math.max(0, elapsed) / 1000) * c.rate;
    };
    progressNowRef.current = now;
    const compute = () => getActiveLyricIndex(data.synced, now(), offset);
    setIdx(compute());
    if (!data.isPlaying) return;
    let raf = 0;
    const loop = () => {
      const next = compute();
      setIdx((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [data, syncOffsetMs, clockTick]);

  const synced = data?.synced ?? [];

  if (!data || (!data.synced?.length && !data.text)) {
    return (
      <div
        className={`overlay-root size-md align-bottom${IS_SECOND_SCREEN ? ' second-screen' : ''}`}
        onMouseDown={startWindowDrag}
        title={s.drag}
      >
        <div className="overlay-panel overlay-panel--idle" ref={setPanelRef}>
          <OverlayChrome label={s.close} />
          <div className="overlay-idle">
            {data?.title ? s.lyricsNone : s.lyricsIdle}
            <span className="overlay-idle-sub">
              {data?.title ? `${data.title} - ${data.artist}` : s.lyricsIdleHint}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const rootClass = [
    'overlay-root',
    `size-${data.fontSize}`,
    `align-${data.align}`,
    data.highContrast ? 'high-contrast' : '',
    data.secondScreen ? 'second-screen' : '',
    data.hideTrackMeta ? 'lyrics-only' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClass}
      onMouseDown={startWindowDrag}
      style={
        {
          '--overlay-opacity': data.opacity,
        } as CSSProperties
      }
    >
      <div className="overlay-panel" ref={setPanelRef}>
        <OverlayChrome label={s.close} />
        {!data.hideTrackMeta && <TrackMeta data={data} />}
        {synced.length > 0 ? (
          <div className="overlay-lyrics-stage">
            <OverlayLines synced={synced} idx={idx} getProgress={getOverlayProgress} />
          </div>
        ) : (
          <div className="overlay-plain">{data.text}</div>
        )}
      </div>
    </div>
  );
}
