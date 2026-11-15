import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { LyricKaraokeText } from '../components/LyricKaraokeText';
import type { OverlayPayload } from './types';
import { getLyricsSyncOffset, overlaySettings } from '../plugins/lyricsOverlay';
import { useLyricsExtras, type LineExtras } from '../lyrics/extras';
import { PlainLyrics } from '../components/PlainLyrics';
import { headlessLyrics, listenHeadless } from '../utils/headlessFeed';
import { getActiveLyricIndex, lyricLineEnd, secondsUntilLyricChange } from '../lyrics/active';
import { imgErr, isYouTubeVideoId } from '../utils/covers';
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
  extras,
}: {
  synced: { time: number; text: string }[];
  idx: number;
  getProgress: () => number;
  extras?: LineExtras;
}) {
  const cur = idx >= 0 ? synced[idx] : null;
  const end = lyricLineEnd(synced, idx);
  const prev = idx > 0 ? synced[idx - 1] : null;
  const next = synced[idx + 1] ?? null;
  return (
    <div className="ov-lines" key={idx}>
      <div className="ov-line ov-line--side ov-line--prev" aria-hidden>
        {prev?.text || '\u00a0'}
      </div>
      <div
        className="ov-line ov-line--active"
        style={{ '--line-scale': lineScale(cur?.text ?? '') } as CSSProperties}
      >
        {cur?.text ? (
          <>
            <LyricKaraokeText
              text={cur.text}
              active
              start={cur.time}
              end={end}
              getProgress={getProgress}
            />
            {extras?.roman && (
              <span className="ov-sub ov-sub--roman">
                <LyricKaraokeText
                  text={extras.roman}
                  active
                  start={cur.time}
                  end={end}
                  getProgress={getProgress}
                />
              </span>
            )}
            {extras?.trans && <span className="ov-sub ov-sub--trans">{extras.trans}</span>}
          </>
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
  const lyricsRef = useRef<Pick<
    OverlayPayload,
    'trackId' | 'synced' | 'text' | 'lyricsPending'
  > | null>(null);
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

  const ingest = useCallback((raw: OverlayPayload) => {
    if (IS_SECOND_SCREEN !== Boolean(raw.secondScreen)) return;
    if (!raw.lyricsSame) {
      lyricsRef.current = {
        trackId: raw.trackId,
        synced: raw.synced,
        text: raw.text,
        lyricsPending: raw.lyricsPending,
      };
    }
    // paczka bez tekstu przed pierwszą pełną (np. po przeładowaniu okna) nie ma z czym się skleić
    else if (!lyricsRef.current) return;
    const p: OverlayPayload = raw.lyricsSame ? { ...raw, ...lyricsRef.current } : raw;
    const c = clockRef.current;
    // paczka bez tempa (np. po zmianie ustawień) nie może cofnąć zegara do 1x
    const rate = p.rate && p.rate > 0 ? p.rate : c.rate;
    const at = performance.now();
    const restart = c.playing !== p.isPlaying || c.rate !== rate;
    // kotwica przy każdej paczce, bo IPC spóźnia się o kilka ms i każdy próg daje widoczny dryf
    clockRef.current = { progress: p.progress, at, seen: at, playing: p.isPlaying, rate };
    if (restart) setClockTick((n) => n + 1);
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
        prev.lyricsPending === p.lyricsPending &&
        (prev.text?.length ?? 0) === (p.text?.length ?? 0) &&
        prev.coverUrl === p.coverUrl;
      if (sameTrack && prev.isPlaying === p.isPlaying) return prev;
      if (sameTrack) return { ...prev, isPlaying: p.isPlaying, progress: p.progress };
      return p;
    });

    const persistKey = `${p.title}|${p.artist}|${p.synced?.length ?? 0}`;
    if (persistKey !== lastPersistKeyRef.current) {
      lastPersistKeyRef.current = persistKey;
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
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlayPayload>('zenith-lyrics-overlay', (e) => ingest(e.payload)).then((fn) => {
      unlisten = fn;
      void emit('zenith-overlay-ready', currentWindowLabel());
    });
    return () => unlisten?.();
  }, [ingest]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let asked = '';
    let last: OverlayPayload | null = null;
    // bez okna głównego tekst pobieramy tu, a utwór i zegar przychodzą prosto z Rusta
    listenHeadless((now) => {
      const tr = now.track;
      // powrót do utworu z wcześniejszego okresu bez okna musi pobrać tekst od nowa
      if (last?.trackId !== tr.id) asked = '';
      last = {
        title: tr.title,
        artist: tr.artist,
        trackId: tr.id,
        coverUrl: tr.coverLarge || tr.cover,
        progress: now.t,
        rate: now.rate,
        isPlaying: now.playing,
        ...overlaySettings(IS_SECOND_SCREEN),
      };
      const known = lyricsRef.current?.trackId === tr.id;
      ingest(known ? { ...last, lyricsSame: true } : { ...last, lyricsPending: true });
      if (known || asked === tr.id) return;
      asked = tr.id;
      void headlessLyrics(now).then((l) => {
        if (!alive || last?.trackId !== tr.id) return;
        ingest({ ...last, synced: l?.synced, text: l?.text ?? null });
      });
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [ingest]);

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
    progressNowRef.current = () => now() + offset / 1000;
    const compute = () => getActiveLyricIndex(data.synced, now(), offset);
    setIdx(compute());
    if (!data.isPlaying) return;
    // budzimy się tuż przed następną linią zamiast w każdej klatce; nakładka jest zawsze widoczna i nie zwalnia
    let timer = 0;
    const loop = () => {
      const next = compute();
      setIdx((prev) => (prev === next ? prev : next));
      const rate = clockRef.current.rate > 0 ? clockRef.current.rate : 1;
      const wait = (secondsUntilLyricChange(data.synced, now(), next, offset) / rate) * 1000 - 40;
      timer = window.setTimeout(loop, Math.max(16, Math.min(wait, 250)));
    };
    loop();
    return () => window.clearTimeout(timer);
  }, [data, syncOffsetMs, clockTick]);

  const synced = data?.synced ?? [];
  const extras = useLyricsExtras(
    synced.map((l) => l.text),
    lang
  );

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
            {data?.title && !data.lyricsPending ? s.lyricsNone : s.lyricsIdle}
            <span className="overlay-idle-sub">
              {data?.title && !data.hideTrackMeta
                ? `${data.title} - ${data.artist}`
                : s.lyricsIdleHint}
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
            <OverlayLines
              synced={synced}
              idx={idx}
              getProgress={getOverlayProgress}
              extras={idx >= 0 ? extras[idx] : undefined}
            />
          </div>
        ) : (
          <PlainLyrics text={data.text ?? ''} translateTo={lang} className="overlay-plain" />
        )}
      </div>
    </div>
  );
}
