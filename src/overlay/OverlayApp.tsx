import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { SyncedLyricsRail, SYNCED_LYRICS_SLIDE_MS } from '../components/SyncedLyricsRail';
import type { OverlayPayload } from './types';
import { getLyricsSyncOffset } from '../plugins/lyricsOverlay';
import { getActiveLyricIndex } from '../utils/activeLyricIndex';
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

function autoFontSize(line: string, secondScreen: boolean): string {
  const len = line.length;
  if (secondScreen) {
    if (len > 90) return 'clamp(36px, 5vw, 52px)';
    if (len > 55) return 'clamp(44px, 6vw, 64px)';
    if (len > 35) return 'clamp(52px, 7vw, 76px)';
    return 'clamp(58px, 8vw, 88px)';
  }
  if (len > 90) return 'clamp(20px, 2.8vw, 28px)';
  if (len > 55) return 'clamp(24px, 3.2vw, 34px)';
  if (len > 35) return 'clamp(28px, 3.8vw, 40px)';
  return 'clamp(32px, 4.5vw, 48px)';
}

function longestLine(synced: { text: string }[]): string {
  if (!synced.length) return '';
  return synced.reduce((best, l) => (l.text.length > best.length ? l.text : best), synced[0].text);
}

export default function OverlayApp() {
  const lang = useAuxLang();
  const s = AUX_STRINGS[lang];
  const [data, setData] = useState<OverlayPayload | null>(null);
  const [beat, setBeat] = useState(false);
  const lastLineRef = useRef(-1);
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
    [],
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
      // the second-screen window only takes payloads meant for it
      if (IS_SECOND_SCREEN !== Boolean(p.secondScreen)) return;
      setData((prev) => {
        if (!prev) return p;
        const sameTrack =
          prev.title === p.title &&
          prev.artist === p.artist &&
          prev.synced?.length === p.synced?.length &&
          prev.activeLyricIndex === p.activeLyricIndex &&
          prev.karaoke === p.karaoke &&
          prev.highContrast === p.highContrast &&
          prev.fontSize === p.fontSize &&
          prev.align === p.align &&
          prev.secondScreen === p.secondScreen &&
          prev.hideTrackMeta === p.hideTrackMeta &&
          prev.opacity === p.opacity &&
          prev.syncOffsetMs === p.syncOffsetMs &&
          (prev.text?.length ?? 0) === (p.text?.length ?? 0) &&
          prev.coverUrl === p.coverUrl;
        if (sameTrack && prev.isPlaying === p.isPlaying) {
          if (Math.abs((prev.progress || 0) - p.progress) < 0.35) return prev;
          return { ...prev, progress: p.progress };
        }
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
        } catch {}
      }
    }).then((fn) => {
      unlisten = fn;
      // ask the main window for a full snapshot, otherwise a paused track shows nothing
      void emit('zenith-overlay-ready', currentWindowLabel()).catch(() => {});
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
    const origin = {
      progress: data.progress,
      at: performance.now(),
      playing: data.isPlaying,
    };
    const now = () => {
      const elapsed = Math.max(0, performance.now() - origin.at) / 1000;
      return origin.playing ? origin.progress + Math.min(elapsed, 1.6) : origin.progress;
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
  }, [data, syncOffsetMs]);

  useEffect(() => {
    if (idx >= 0 && idx !== lastLineRef.current) {
      lastLineRef.current = idx;
      setBeat(true);
      const t = setTimeout(() => setBeat(false), 600);
      return () => clearTimeout(t);
    }
  }, [idx]);

  const synced = data?.synced ?? [];
  const dynamicSize = useMemo(() => {
    if (!data || data.fontSize !== 'auto' || !synced.length) return undefined;
    return autoFontSize(longestLine(synced), Boolean(data.secondScreen));
  }, [data, synced.length]);

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
    data.karaoke ? 'karaoke' : '',
    data.highContrast ? 'high-contrast' : '',
    data.secondScreen ? 'second-screen' : '',
    data.hideTrackMeta ? 'lyrics-only' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const railClass = ['synced-lyrics-rail--overlay', 'synced-lyrics-rail--center']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rootClass}
      onMouseDown={startWindowDrag}
      style={
        {
          '--overlay-opacity': data.opacity,
          '--slide-ms': `${SYNCED_LYRICS_SLIDE_MS}ms`,
          ...(dynamicSize ? { '--font-size': dynamicSize, '--auto-size': dynamicSize } : {}),
        } as CSSProperties
      }
    >
      <div className="overlay-panel" ref={setPanelRef}>
        <OverlayChrome label={s.close} />
        {beat && data.karaoke && <div className="overlay-beat" />}
        {!data.secondScreen && !data.hideTrackMeta && (
          <div className="overlay-meta">
            {data.coverUrl && (
              <img
                src={data.coverUrl}
                alt=""
                className="overlay-cover"
                loading="lazy"
                decoding="async"
                onError={imgErr}
                {...(isYouTubeVideoId(data.trackId) ? { 'data-video-id': data.trackId } : {})}
              />
            )}
            <div className="overlay-meta-text">
              <div className="overlay-track-title">{data.title}</div>
              <div className="overlay-track-artist">{data.artist}</div>
            </div>
          </div>
        )}
        {synced.length > 0 ? (
          <div className="overlay-lyrics-stage">
            <SyncedLyricsRail
              synced={synced}
              idx={idx}
              className={railClass}
              showPrevious
              getProgress={getOverlayProgress}
            />
          </div>
        ) : (
          <div className="overlay-plain">{data.text}</div>
        )}
      </div>
    </div>
  );
}
