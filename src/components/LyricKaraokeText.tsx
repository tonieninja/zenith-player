import { useEffect, useRef, useState } from 'react';
import { useLightLyrics } from '../lyrics/light';

// wymazywanie skacze 30 razy na sekundę: przy miękkiej krawędzi wygląda płynnie, a WebView2 nie rysuje 60 klatek
const WIPE_FRAME_MS = 1000 / 30;
const wipeEasing = (ms: number) =>
  `steps(${Math.max(1, Math.round(ms / WIPE_FRAME_MS))}, jump-end)`;

type Row = { x: number; w: number; y0: number; y1: number; t0: number; t1: number };

function measureRows(fill: HTMLElement): Row[] {
  const W = fill.offsetWidth;
  const H = fill.offsetHeight;
  if (W <= 0 || H <= 0) return [];
  const box = fill.getBoundingClientRect();
  const sx = box.width / W || 1;
  const sy = box.height / H || 1;
  const raw: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const range = document.createRange();
  range.selectNodeContents(fill);
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const x0 = (r.left - box.left) / sx;
    const x1 = (r.right - box.left) / sx;
    const y0 = (r.top - box.top) / sy;
    const y1 = (r.bottom - box.top) / sy;
    const same = raw.find((q) => Math.abs((q.y0 + q.y1) / 2 - (y0 + y1) / 2) < (y1 - y0) / 2);
    if (same) {
      same.x0 = Math.min(same.x0, x0);
      same.x1 = Math.max(same.x1, x1);
      same.y0 = Math.min(same.y0, y0);
      same.y1 = Math.max(same.y1, y1);
    } else raw.push({ x0, x1, y0, y1 });
  }
  range.detach?.();
  if (!raw.length) raw.push({ x0: 0, x1: W, y0: 0, y1: H });
  raw.sort((p, q) => p.y0 - q.y0);
  const total = raw.reduce((acc, r) => acc + (r.x1 - r.x0), 0) || 1;
  const pad = Math.max(8, Math.round(parseFloat(getComputedStyle(fill).fontSize || '16') * 0.6));
  let t = 0;
  return raw.map((r, i) => {
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const y0 = prev ? (prev.y1 + r.y0) / 2 : Math.min(0, r.y0) - pad;
    const y1 = next ? (r.y1 + next.y0) / 2 : Math.max(H, r.y1) + pad;
    const t0 = t;
    t += (r.x1 - r.x0) / total;
    return {
      x: Math.floor(r.x0),
      w: Math.ceil(r.x1 - r.x0),
      y0: Math.floor(y0),
      y1: Math.ceil(y1),
      t0,
      t1: i === raw.length - 1 ? 1 : t,
    };
  });
}

function watchLayout(fill: HTMLElement, rebuild: () => void): () => void {
  let key = `${fill.offsetWidth}x${fill.offsetHeight}`;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const k = `${fill.offsetWidth}x${fill.offsetHeight}`;
          if (k === key) return;
          key = k;
          rebuild();
        })
      : null;
  ro?.observe(fill);
  let alive = true;
  if (document.fonts && document.fonts.status !== 'loaded') {
    void document.fonts.ready.then(() => alive && rebuild());
  }
  return () => {
    alive = false;
    ro?.disconnect();
  };
}

// tempo z poprzedniej linii: nowa nie startuje w 1x, więc nie odskakuje przez pierwsze pół sekundy
let knownRate = 1;

function driveWipe(
  getAnims: () => Animation[],
  span: number,
  pos: () => number,
  setPlaying: (p: boolean) => void,
  live: boolean
): () => void {
  const clamp = (v: number) => Math.max(0, Math.min(span, v)) * 1000;
  const setAll = (ms: number) => getAnims().forEach((a) => (a.currentTime = ms));
  let playing = true;
  const setP = (p: boolean) => {
    playing = p;
    setPlaying(p);
  };
  let last = pos();
  let lastAt = performance.now();
  let seenRate = knownRate;
  if (knownRate !== 1) getAnims().forEach((a) => a.updatePlaybackRate(knownRate));
  setP(last >= 0 && last < span);
  setAll(clamp(last));
  if (!playing) getAnims().forEach((a) => a.pause());
  let stalls = 0;
  let heldAt = Number.NaN;
  const sync = () => {
    const now = pos();
    const at = performance.now();
    // tempo odtwarzania z dwóch odczytów zegara, zaokrąglone do 0,05, żeby szum go nie przestawiał
    const rate = Math.round(((now - last) / Math.max(1, at - lastAt)) * 20000) / 20;
    lastAt = at;
    stalls = now === last ? stalls + 1 : 0;
    const advancing = stalls < 1;
    last = now;
    const want = clamp(now);
    if (!getAnims().length) return;
    if (!advancing || now < 0 || now >= span) {
      if (playing) {
        setP(false);
        getAnims().forEach((a) => a.pause());
        setAll(want);
        heldAt = want;
      } else if (want !== heldAt) {
        setAll(want);
        heldAt = want;
      }
    } else if (!playing) {
      setP(true);
      heldAt = Number.NaN;
      getAnims().forEach((a) => a.play());
      setAll(want);
    } else {
      const all = getAnims();
      const ref = all[all.length - 1];
      // dwa zgodne odczyty, bo pojedynczy skok (przewinięcie) wyglądałby jak tempo 3x
      if (rate === seenRate && rate >= 0.25 && rate <= 4 && ref.playbackRate !== rate) {
        knownRate = rate;
        all.forEach((a) => a.updatePlaybackRate(rate));
      }
      if (ref.playState !== 'paused' && Math.abs(Number(ref.currentTime ?? 0) - want) > 60) {
        setAll(want);
      }
    }
    seenRate = rate;
  };
  let iv = 0;
  const start = () => {
    // animacja sama trzyma czas, a zegary okien są ekstrapolowane: 4 sprawdzenia na sekundę łapią pauzę i dryf
    if (live && !iv) iv = window.setInterval(sync, 250);
  };
  const stop = () => {
    window.clearInterval(iv);
    iv = 0;
  };
  const onVis = () => {
    if (document.hidden) stop();
    else {
      sync();
      start();
    }
  };
  // w pauzie jedno sprawdzenie zatrzymuje animację; wznowienie i tak buduje efekt od nowa
  if (!live) sync();
  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
  };
}

function runTransformWipe(
  wrap: HTMLElement,
  fill: HTMLElement,
  span: number,
  pos: () => number,
  live: boolean
): () => void {
  const durMs = span * 1000;
  let layers: HTMLElement[] = [];
  let anims: Animation[] = [];

  const build = () => {
    const W = fill.offsetWidth;
    const H = fill.offsetHeight;
    const rows = measureRows(fill);
    if (!rows.length) return;
    const wasPaused = anims.some((a) => a.playState === 'paused');
    anims.forEach((a) => a.cancel());
    layers.forEach((l) => l.remove());
    layers = [];
    anims = [];
    const feather = Math.max(
      8,
      Math.round(parseFloat(getComputedStyle(fill).fontSize || '16') * 0.9)
    );
    for (const row of rows) {
      const lead = Math.min(row.x, 24);
      const left = row.x - lead;
      const full = row.w + lead + feather;
      const clipper = document.createElement('span');
      clipper.className = 'lyric-karaoke-clip';
      clipper.setAttribute('aria-hidden', 'true');
      // stan bazowy to pusta linia: klatka bez animacji nie może błysnąć całym tekstem
      clipper.style.cssText = `inset:auto;left:${left}px;top:${row.y0}px;width:${full}px;height:${row.y1 - row.y0}px;transform:translate3d(${-full}px,0,0);`;
      const copy = fill.cloneNode(true) as HTMLElement;
      copy.classList.add('lyric-karaoke-fill-moving');
      copy.style.cssText = `inset:auto;position:absolute;left:${-left}px;top:${-row.y0}px;width:${W}px;height:${H}px;transform:translate3d(${full}px,0,0);`;
      clipper.appendChild(copy);
      wrap.appendChild(clipper);
      const timing: KeyframeAnimationOptions = {
        delay: row.t0 * durMs,
        duration: Math.max(1, (row.t1 - row.t0) * durMs),
        easing: wipeEasing((row.t1 - row.t0) * durMs),
        fill: 'both',
      };
      anims.push(
        clipper.animate(
          [{ transform: `translate3d(${-full}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          timing
        ),
        copy.animate(
          [{ transform: `translate3d(${full}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          timing
        )
      );
      layers.push(clipper);
    }
    fill.style.visibility = 'hidden';
    const ms = Math.max(0, Math.min(span, pos())) * 1000;
    anims.forEach((a) => (a.currentTime = ms));
    if (wasPaused) anims.forEach((a) => a.pause());
  };

  build();
  const stopLayout = watchLayout(fill, build);
  const stopSync = driveWipe(
    () => anims,
    span,
    pos,
    () => {},
    live
  );
  return () => {
    stopSync();
    stopLayout();
    anims.forEach((a) => a.cancel());
    layers.forEach((l) => l.remove());
    fill.style.visibility = '';
  };
}

// pierwsza litera hebrajska lub arabska: wypełnienie idzie od lewej, więc taka linia zostaje bez niego
const RTL_FIRST = /^\P{L}*[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;

type Props = {
  text: string;
  active: boolean;
  start: number;
  end: number;
  getProgress?: () => number;
  // bez tego zegar synchronizacji tyka 4 razy na sekundę także w pauzie
  playing?: boolean;
};

export function LyricKaraokeText({
  text,
  active: activeProp,
  start,
  end,
  getProgress,
  playing = true,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const light = useLightLyrics();
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    if (!activeProp || light) return;
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOnScreen(e.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      setOnScreen(true);
    };
  }, [activeProp, light]);
  const active = activeProp && !light && !RTL_FIRST.test(text);
  const animate = active && onScreen;

  useEffect(() => {
    if (!animate) return;
    const el = wrapRef.current;
    if (!el) return;
    const span = Math.max(0.32, end - start);
    const pos = () => (getProgress?.() ?? start) - start;

    const fill = el.querySelector<HTMLElement>('.lyric-karaoke-fill');
    if (fill && typeof fill.animate === 'function') {
      return runTransformWipe(el, fill, span, pos, playing);
    }

    let raf = 0;
    const tick = () => {
      const p = Math.max(0, Math.min(1, pos() / span));
      el.style.setProperty('--karaoke-p', `${(p * 100).toFixed(2)}%`);
      if (playing) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, start, end, getProgress, playing]);

  if (!active) {
    return (
      <span className="lyric-row-text" data-text={text} dir="auto">
        {text}
      </span>
    );
  }

  return (
    <span className="lyric-row-text lyric-karaoke" data-text={text} ref={wrapRef} dir="auto">
      <span className="lyric-karaoke-base">{text}</span>
      <span className="lyric-karaoke-fill" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
