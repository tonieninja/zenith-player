import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { emit, listen } from '@tauri-apps/api/event';
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window';
import { MicVocal, ThumbsUp } from 'lucide-react';
import type { Track } from '../api/youtube';
import { LyricKaraokeText } from '../components/LyricKaraokeText';
import { getActiveLyricIndex, lyricLineEnd, secondsUntilLyricChange } from '../lyrics/active';
import { useLyricsExtras } from '../lyrics/extras';
import type { OverlayLyricsLine, OverlayPayload } from '../overlay/types';
import { getLyricsSyncOffset } from '../plugins/lyricsOverlay';
import { miniHidden, miniLyrics, type MiniPlayerPayload } from '../plugins/miniPlayer';
import {
  headlessLyrics,
  headlessToggleLike,
  isFavorite,
  listenHeadless,
  type HeadlessNow,
} from '../utils/headlessFeed';
import { imgErr, isYouTubeVideoId } from '../utils/covers';
import { coverLedColor } from '../utils/coverTheme';
import { formatTime } from '../utils/playback';
import {
  AUX_STRINGS,
  closeThisWindow,
  markOpaqueAuxWindow,
  startWindowDrag,
  useAuxLang,
} from '../utils/auxWindow';
import './mini.css';

type Strings = (typeof AUX_STRINGS)[keyof typeof AUX_STRINGS];
type Clock = { progress: number; at: number; playing: boolean; rate: number };

const FRAME_MS = 1000 / 60;
const easeOut = (t: number) => 1 - (1 - t) ** 5;
type Pose = { y: number; s: number; o: number };

// przejście linii liczy się co ~16 ms, nie w każdej klatce monitora: na 200 Hz to ponad 3 razy mniej rysowania
function glide(el: Element | null, from: Pose, to: Pose, ms: number, fill: FillMode, delay = 0) {
  if (!el || typeof el.animate !== 'function') return;
  const n = Math.max(1, Math.round(ms / FRAME_MS));
  const at = (a: number, b: number, e: number) => a + (b - a) * e;
  const frames = Array.from({ length: n + 1 }, (_, k) => {
    const e = easeOut(k / n);
    return {
      transform: `translate3d(0, ${at(from.y, to.y, e)}px, 0) scale(${at(from.s, to.s, e)})`,
      opacity: at(from.o, to.o, e),
    };
  });
  el.animate(frames, { duration: ms, delay, easing: `steps(${n}, jump-end)`, fill });
}

const clockNow = (c: Clock) =>
  c.playing ? c.progress + (Math.max(0, performance.now() - c.at) / 1000) * c.rate : c.progress;
type MiniLyricsState = {
  trackId?: string;
  synced?: OverlayLyricsLine[];
  text?: string | null;
  syncOffsetMs?: number;
  pending?: boolean;
};

const BASE_H = 96;
const LYRICS_H = 152;

// okno rośnie w dół: zaparkowane przy dolnej krawędzi wyjechałoby za ekran, więc wraca w obszar roboczy
async function growOnScreen(height: number) {
  const win = getCurrentWindow();
  await win.setSize(new LogicalSize(window.innerWidth, height));
  const [mon, pos, size] = await Promise.all([
    currentMonitor(),
    win.outerPosition(),
    win.outerSize(),
  ]);
  if (!mon) return;
  const { position: a, size: s } = mon.workArea;
  const x = Math.max(a.x, Math.min(pos.x, a.x + s.width - size.width));
  const y = Math.max(a.y, Math.min(pos.y, a.y + s.height - size.height));
  if (x !== pos.x || y !== pos.y) await win.setPosition(new PhysicalPosition(x, y));
}

const act = (action: string) => void emit('zenith-mini-action', action);

function CloseButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="mini-chip"
      onClick={() => void closeThisWindow()}
      aria-label={label}
      title={label}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

function SeekBar({
  data,
  clock,
  label,
  onSeek,
}: {
  data: MiniPlayerPayload;
  clock: Clock;
  label: string;
  onSeek: (t: number) => void;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<Animation | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const d = data.duration;

  useEffect(() => {
    const el = fillRef.current;
    runRef.current?.cancel();
    runRef.current = null;
    if (!el) return;
    if (drag !== null) {
      el.style.transform = `scaleX(${drag})`;
      return;
    }
    const t = clockNow(clock);
    const p0 = d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
    el.style.transform = `scaleX(${p0})`;
    if (!clock.playing || d <= 0 || p0 >= 1) return;
    // pasek przesuwa się co pełny piksel, więc kompozytor rysuje raz na sekundę lub rzadziej zamiast 60 razy
    const px = (el.parentElement?.offsetWidth ?? 0) * devicePixelRatio * (1 - p0);
    runRef.current = el.animate([{ transform: `scaleX(${p0})` }, { transform: 'scaleX(1)' }], {
      duration: ((d - t) / clock.rate) * 1000,
      easing: `steps(${Math.max(1, Math.round(px))}, jump-end)`,
      fill: 'forwards',
    });
  }, [clock, d, drag]);

  const frac = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  };

  const seekable = d > 0;
  const shown = drag ?? hover;
  const now = Math.min(d, Math.max(0, data.progress));

  return (
    <div
      className={`mini-seek${drag !== null ? ' is-dragging' : ''}${seekable ? '' : ' is-locked'}`}
      data-no-drag
      role="slider"
      tabIndex={seekable ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={Math.round(now)}
      aria-valuetext={`${formatTime(now)} / ${formatTime(d)}`}
      onPointerDown={(e) => {
        if (!seekable || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(frac(e));
      }}
      onPointerMove={(e) => {
        if (!seekable) return;
        const f = frac(e);
        setHover(f);
        if (drag !== null) setDrag(f);
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(frac(e) * d);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (!seekable) return;
        const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
        if (!step) return;
        e.preventDefault();
        onSeek(Math.max(0, Math.min(d - 0.5, now + step)));
      }}
    >
      <div className="mini-progress">
        <div className="mini-progress-fill" ref={fillRef} />
      </div>
      {shown !== null && seekable && (
        <>
          <span className="mini-seek-thumb" style={{ left: `${shown * 100}%` }} />
          <span
            className="mini-seek-time"
            style={{ left: `clamp(16px, ${shown * 100}%, calc(100% - 16px))` }}
          >
            {formatTime(shown * d)}
          </span>
        </>
      )}
    </div>
  );
}

function MiniLyrics({
  lyr,
  clockRef,
  clock,
  playing,
  s,
  lang,
}: {
  lyr: MiniLyricsState | null;
  clockRef: { current: Clock };
  clock: Clock;
  playing: boolean;
  s: Strings;
  lang: string;
}) {
  const lines = lyr?.synced;
  const offsetMs = lyr?.syncOffsetMs ?? 0;
  const extras = useLyricsExtras(lines?.map((l) => l.text) ?? [], lang);
  // prev to linia, która właśnie schodzi; jej wyjście i wejście następnej to jedno płynne przejście
  const [{ idx, prev, moved }, setPos] = useState({ idx: -1, prev: -1, moved: false });
  const now = useCallback(() => clockNow(clockRef.current), [clockRef]);
  const boxRef = useRef<HTMLDivElement>(null);

  // stara linia wyjeżdża w górę, nowa rośnie z miejsca szarej następnej (12/15 = 0,8), obie o 22 px naraz
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!moved || !box) return;
    const page = box.querySelector('.mini-lyrics-page.is-entering');
    const out = box.querySelector('.mini-lyrics-page.is-leaving');
    glide(out, { y: 0, s: 1, o: 1 }, { y: -22, s: 1, o: 0 }, 440, 'forwards');
    const cur = page?.querySelector('.mini-lyric.is-active') ?? null;
    glide(cur, { y: 22, s: 0.8, o: 0.4 }, { y: 0, s: 1, o: 1 }, 440, 'backwards');
    page?.querySelectorAll('.mini-lyric.is-next, .mini-lyric.is-sub').forEach((el) => {
      glide(el, { y: 10, s: 1, o: 0 }, { y: 0, s: 1, o: 1 }, 440, 'backwards', 60);
    });
  }, [idx, moved]);
  const getProgress = useCallback(() => now() + offsetMs / 1000, [now, offsetMs]);

  useEffect(() => {
    if (!lines?.length) {
      setPos({ idx: -1, prev: -1, moved: false });
      return;
    }
    const compute = () => getActiveLyricIndex(lines, now(), offsetMs);
    const first = compute();
    setPos((p) => (p.idx === first ? p : { idx: first, prev: -1, moved: false }));
    if (!playing) return;
    // budzimy się tylko tuż przed następną linią; przewinięcie zmienia zegar i uruchamia efekt od nowa
    let timer = 0;
    const loop = () => {
      const next = compute();
      setPos((p) => (p.idx === next ? p : { idx: next, prev: p.idx, moved: true }));
      const rate = clockRef.current.rate > 0 ? clockRef.current.rate : 1;
      const wait = (secondsUntilLyricChange(lines, now(), next, offsetMs) / rate) * 1000 - 40;
      if (Number.isFinite(wait)) timer = window.setTimeout(loop, Math.max(16, wait));
    };
    loop();
    return () => window.clearTimeout(timer);
  }, [lines, offsetMs, playing, now, clockRef, clock]);

  if (!lines?.length) {
    const label = lyr?.pending ? s.lyricsLoading : lyr?.text ? s.lyricsUnsynced : s.lyricsNone;
    return (
      <div className="mini-lyrics is-empty">
        <span>{label}</span>
      </div>
    );
  }
  const cur = idx >= 0 ? lines[idx] : null;
  const next = lines[idx + 1] ?? null;
  const end = lyricLineEnd(lines, idx);
  const { roman, trans } = (idx >= 0 && extras[idx]) || {};
  const gone = prev >= 0 && prev !== idx ? lines[prev] : null;
  return (
    <div className={`mini-lyrics${roman || trans ? ' has-extras' : ''}`} ref={boxRef}>
      {gone?.text && (
        <div className="mini-lyrics-page is-leaving" key={`out-${prev}-${idx}`} aria-hidden>
          <div className="mini-lyric is-active">{gone.text}</div>
          <div className="mini-lyric is-next is-ghost">{lines[prev + 1]?.text || ' '}</div>
        </div>
      )}
      <div className={`mini-lyrics-page${moved ? ' is-entering' : ''}`} key={idx}>
        <div className="mini-lyric is-active">
          {cur?.text ? (
            <LyricKaraokeText
              text={cur.text}
              active
              start={cur.time}
              end={end}
              getProgress={getProgress}
              playing={playing}
            />
          ) : (
            '♪'
          )}
        </div>
        {cur && roman && (
          <div className="mini-lyric is-sub is-roman">
            <LyricKaraokeText
              text={roman}
              active
              start={cur.time}
              end={end}
              getProgress={getProgress}
              playing={playing}
            />
          </div>
        )}
        {cur && trans && <div className="mini-lyric is-sub is-trans">{trans}</div>}
        {!(roman && trans) && (
          <div className="mini-lyric is-next" aria-hidden>
            {next?.text || ' '}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniApp() {
  const lang = useAuxLang();
  const s = AUX_STRINGS[lang];
  const [data, setData] = useState<MiniPlayerPayload | null>(null);
  const [lyr, setLyr] = useState<MiniLyricsState | null>(null);
  const lyrRef = useRef(lyr);
  lyrRef.current = lyr;
  // bez okna głównego utwór przychodzi z Rusta, a tekst i polubienie obsługuje samo mini okno
  const [headNow, setHeadNow] = useState<HeadlessNow | null>(null);
  const headTrackRef = useRef<Track | null>(null);
  const showLyrics = miniLyrics.useValue();
  const hide = {
    play: miniHidden.play.useValue(),
    seek: miniHidden.seek.useValue(),
    like: miniHidden.like.useValue(),
    prev: miniHidden.prev.useValue(),
    next: miniHidden.next.useValue(),
  };
  const clockRef = useRef<Clock>({ progress: 0, at: 0, playing: false, rate: 1 });

  const anchor = (progress: number, playing: boolean, rate?: number) => {
    const c = clockRef.current;
    // paczka bez tempa (część wysyłek go nie podaje) zostawia ostatnie znane zamiast cofać do 1x
    const r = rate && rate > 0 ? rate : c.rate;
    // drgania znacznika z ticków (do 150 ms) nie przestawiają animacji, bo każde przestawienie szarpie wypełnieniem
    if (playing && c.playing && c.rate === r && Math.abs(clockNow(c) - progress) < 0.15) return;
    clockRef.current = { progress, at: performance.now(), playing, rate: r };
  };

  useEffect(() => {
    const stateReady = listen<MiniPlayerPayload>('zenith-mini-state', (e) => {
      headTrackRef.current = null;
      setHeadNow(null);
      anchor(e.payload.progress, e.payload.isPlaying, e.payload.rate);
      setData(e.payload);
    });
    const lyricsReady = listen<OverlayPayload>('zenith-mini-lyrics', (e) => {
      const p = e.payload;
      anchor(p.progress, p.isPlaying, p.rate);
      // paczka z lyricsSame ma tylko zegar, tekst zostaje z poprzedniej
      setLyr((prev) =>
        p.lyricsSame
          ? prev && { ...prev, syncOffsetMs: p.syncOffsetMs }
          : { trackId: p.trackId, synced: p.synced, text: p.text, syncOffsetMs: p.syncOffsetMs }
      );
    });
    // pełny tekst przychodzi raz po „ready”; wysłany przed podpięciem nasłuchu tekstu ginął
    void Promise.all([stateReady, lyricsReady]).then(() => emit('zenith-mini-ready'));
    const headReady = listenHeadless((now) => {
      const tr = now.track;
      headTrackRef.current = tr;
      anchor(now.t, now.playing, now.rate);
      setData((prev) => ({
        title: tr.title,
        artist: tr.artist,
        trackId: tr.id,
        coverUrl: tr.coverSmall || tr.cover,
        progress: now.t,
        duration: now.d ?? tr.durationSec ?? 0,
        isPlaying: now.playing,
        rate: now.rate,
        liked: prev?.trackId === tr.id ? prev.liked : isFavorite(tr.id),
      }));
      setHeadNow((prev) => (prev?.track.id === tr.id ? prev : now));
    });
    return () => {
      // odpinamy po podpięciu: sprzątanie przed rozwiązaniem listen (StrictMode) zostawiało podwójny nasłuch
      for (const ready of [stateReady, lyricsReady, headReady]) void ready.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!headNow || !showLyrics) return;
    const id = headNow.track.id;
    if (lyrRef.current?.trackId === id) return;
    let alive = true;
    setLyr({ trackId: id, pending: true });
    void headlessLyrics(headNow).then((l) => {
      if (!alive) return;
      setLyr({
        trackId: id,
        synced: l?.synced,
        text: l?.text,
        syncOffsetMs: getLyricsSyncOffset(),
      });
    });
    return () => {
      alive = false;
      // przerwane pobieranie nie może zostawić wiecznego wczytywania
      setLyr((prev) => (prev?.pending && prev.trackId === id ? null : prev));
    };
  }, [headNow, showLyrics]);

  useEffect(() => {
    const want = showLyrics ? LYRICS_H : BASE_H;
    if (Math.abs(window.innerHeight - want) < 8) return;
    void growOnScreen(want).catch(() => undefined);
  }, [showLyrics]);

  const [grad, setGrad] = useState<[string, string] | null>(null);
  const coverUrl = data?.coverUrl;
  useEffect(() => {
    if (!coverUrl) return setGrad(null);
    let alive = true;
    void coverLedColor(coverUrl).then((c) => {
      if (!alive) return;
      if (!c) return setGrad(null);
      // drugi przystanek rozjaśniony w stronę bieli, jak w domyślnym przejściu z fioletu do bieli
      const lift = (v: number) => Math.round(v + (255 - v) * 0.6);
      setGrad([`rgb(${c.join(', ')})`, `rgb(${c.map(lift).join(', ')})`]);
    });
    return () => {
      alive = false;
    };
  }, [coverUrl]);

  const seek = useCallback((t: number) => {
    act(`seek:${t.toFixed(2)}`);
    // pasek od razu stoi tam, gdzie puszczono, zanim główne okno odeśle nową pozycję
    setData((prev) => {
      if (!prev) return prev;
      anchor(t, prev.isPlaying, prev.rate);
      return { ...prev, progress: t };
    });
  }, []);

  const chips = (
    <div className="mini-chips">
      <button
        type="button"
        className={`mini-chip${showLyrics ? ' on' : ''}`}
        onClick={() => miniLyrics.set(!showLyrics)}
        aria-pressed={showLyrics}
        aria-label={showLyrics ? s.lyricsHide : s.lyricsShow}
        title={showLyrics ? s.lyricsHide : s.lyricsShow}
      >
        <MicVocal size={10} strokeWidth={2.6} />
      </button>
      <CloseButton label={s.close} />
    </div>
  );

  if (!data?.title) {
    return (
      <div className="mini-root" onMouseDown={startWindowDrag} title={s.drag}>
        <span className="mini-idle">{s.miniIdle}</span>
        {chips}
      </div>
    );
  }

  return (
    <div
      className={`mini-root${showLyrics ? ' has-lyrics' : ''}`}
      style={grad ? ({ '--mini-c1': grad[0], '--mini-c2': grad[1] } as CSSProperties) : undefined}
      onMouseDown={startWindowDrag}
    >
      {chips}
      <div className="mini-main">
        {data.coverUrl && (
          <img
            src={data.coverUrl}
            alt=""
            className="mini-cover"
            onError={imgErr}
            {...(isYouTubeVideoId(data.trackId) ? { 'data-video-id': data.trackId } : {})}
          />
        )}
        <div className="mini-info">
          <div className="mini-title-row">
            <div className="mini-title" title={data.title}>
              {data.title}
            </div>
            {!hide.like && isYouTubeVideoId(data.trackId) && (
              <button
                type="button"
                className={`mini-like${data.liked ? ' on' : ''}`}
                onClick={() => {
                  const want = !data.liked;
                  setData((prev) => prev && { ...prev, liked: want });
                  const tr = headTrackRef.current;
                  if (!tr) return act('like');
                  void headlessToggleLike(tr, want).then((liked) =>
                    setData((prev) => (prev?.trackId === tr.id ? { ...prev, liked } : prev))
                  );
                }}
                aria-pressed={Boolean(data.liked)}
                aria-label={s.like}
                title={s.like}
              >
                <ThumbsUp size={13} strokeWidth={2.4} fill={data.liked ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          <div className="mini-artist">{data.artist}</div>
          {!hide.seek && (
            <SeekBar data={data} clock={clockRef.current} label={s.seek} onSeek={seek} />
          )}
        </div>
        {!(hide.prev && hide.play && hide.next) && (
          <div className="mini-controls">
            {!hide.prev && (
              <button
                className="mini-btn"
                onClick={() => act('prev')}
                aria-label={s.prev}
                title={s.prev}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                </svg>
              </button>
            )}
            {!hide.play && (
              <button
                className="mini-btn play"
                onClick={() => act('toggle-play')}
                aria-label={data.isPlaying ? s.pause : s.play}
                title={data.isPlaying ? s.pause : s.play}
              >
                {data.isPlaying ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            )}
            {!hide.next && (
              <button
                className="mini-btn"
                onClick={() => act('next')}
                aria-label={s.next}
                title={s.next}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
      {showLyrics && (
        <MiniLyrics
          lyr={lyr?.trackId && lyr.trackId !== data.trackId ? null : lyr}
          clockRef={clockRef}
          clock={clockRef.current}
          playing={data.isPlaying}
          s={s}
          lang={lang}
        />
      )}
    </div>
  );
}

markOpaqueAuxWindow();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniApp />
  </StrictMode>
);
