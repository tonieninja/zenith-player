import { useEffect, useRef, useState } from 'react';
import { useLightLyrics } from '../utils/lightLyrics';

/** width of one wipe column in CSS px */
const COLUMN_PX = 24;

type Row = { x: number; w: number; y0: number; y1: number; t0: number; t1: number };

/**
 * the visual rows of a (possibly wrapped) line, in the fill's own CSS px (the active line
 * is scaled by its entry animation, so client rects are divided back). each row gets its own
 * time slice, proportional to its width, so the wipe runs along the first row and then
 * the next one at one constant speed instead of lighting every row at once. bands reach
 * halfway to the neighbouring row (and a pad above/below the outer ones) so the glow is
 * not cut off at the glyph box
 */
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

/** rebuilds the wipe layers when the line reflows (window resize, font load) */
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
  // web fonts can swap in after the first layout and move the row breaks
  let alive = true;
  document.fonts?.ready.then(() => alive && rebuild()).catch(() => {});
  return () => {
    alive = false;
    ro?.disconnect();
  };
}

/**
 * the karaoke wipe without a JS write per frame and without repainting the whole line
 * (WebKitGTK, software painted). the glowing fill is shown through narrow columns: each
 * column is a small box with overflow hidden holding a copy of the fill shifted into place,
 * with its own linear `clip` animation covering its slice of the line's time, row by row.
 * WebKit only invalidates the 24px column under the moving edge. JS only keeps the
 * animations in step with the audio a few times a second (pause, seek, stall)
 */
function runColumnWipe(
  wrap: HTMLElement,
  fill: HTMLElement,
  span: number,
  pos: () => number
): () => void {
  const durMs = span * 1000;
  let cols: HTMLElement[] = [];
  let anims: Animation[] = [];

  const build = () => {
    const W = fill.offsetWidth;
    const H = fill.offsetHeight;
    const rows = measureRows(fill);
    if (!rows.length) return;
    const wasPaused = anims.some((a) => a.playState === 'paused');
    anims.forEach((a) => a.cancel());
    cols.forEach((c) => c.remove());
    cols = [];
    anims = [];
    for (const row of rows) {
      const left = row.x;
      const right = row.x + row.w;
      const h = row.y1 - row.y0;
      const n = Math.max(1, Math.ceil((right - left) / COLUMN_PX));
      const rowMs = (row.t1 - row.t0) * durMs;
      for (let i = 0; i < n; i++) {
        const x0 = left + i * COLUMN_PX;
        const cw = Math.min(right, x0 + COLUMN_PX) - x0;
        // the first column of a row also lights the glow left of the first letter
        const lead = i === 0 ? Math.min(x0, 24) : 0;
        const col = document.createElement('span');
        col.className = 'lyric-karaoke-col';
        col.setAttribute('aria-hidden', 'true');
        col.style.cssText = `position:absolute;left:${x0 - lead}px;top:${row.y0}px;width:${cw + lead}px;height:${h}px;overflow:hidden;pointer-events:none;`;
        const copy = fill.cloneNode(true) as HTMLElement;
        copy.style.cssText = `inset:auto;position:absolute;left:${-(x0 - lead)}px;top:${-row.y0}px;width:${W}px;height:${H}px;clip-path:none;visibility:visible;`;
        col.appendChild(copy);
        wrap.appendChild(col);
        const a = col.animate(
          [
            { clip: `rect(0px, ${lead}px, ${h}px, 0px)` },
            { clip: `rect(0px, ${cw + lead}px, ${h}px, 0px)` },
          ],
          {
            delay: row.t0 * durMs + ((x0 - left) / (right - left)) * rowMs,
            duration: Math.max(1, (cw / (right - left)) * rowMs),
            easing: 'linear',
            fill: 'both',
          }
        );
        cols.push(col);
        anims.push(a);
      }
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
    () => {}
  );
  return () => {
    stopSync();
    stopLayout();
    anims.forEach((a) => a.cancel());
    cols.forEach((c) => c.remove());
    fill.style.visibility = '';
  };
}

/**
 * keeps wipe animations in step with the audio a few times a second (pause, seek,
 * stall); the animations themselves run on their own between polls
 */
function driveWipe(
  getAnims: () => Animation[],
  span: number,
  pos: () => number,
  setPlaying: (p: boolean) => void
): () => void {
  const clamp = (v: number) => Math.max(0, Math.min(span, v)) * 1000;
  const setAll = (ms: number) => getAnims().forEach((a) => (a.currentTime = ms));
  let playing = true;
  const setP = (p: boolean) => {
    playing = p;
    setPlaying(p);
  };
  let last = pos();
  setP(last >= 0 && last < span);
  setAll(clamp(last));
  if (!playing) getAnims().forEach((a) => a.pause());
  let stalls = 0;
  let heldAt = Number.NaN;
  const sync = () => {
    const now = pos();
    // currentTime can repeat across one poll; two in a row means paused/buffering
    stalls = now === last ? stalls + 1 : 0;
    const advancing = stalls < 2;
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
        // paused: only touch the columns when the position really moved (seek while
        // paused); re-setting the same time every 50ms kept WebKit restyling 24 columns
        setAll(want);
        heldAt = want;
      }
    } else if (!playing) {
      setP(true);
      heldAt = Number.NaN;
      // play() rewinds finished columns, so put every column back at the audio position
      getAnims().forEach((a) => a.play());
      setAll(want);
    } else {
      // the last column's window ends with the line, so it is the one clock that keeps
      // running for the whole line (earlier columns finish and stop counting)
      const all = getAnims();
      const ref = all[all.length - 1];
      if (ref.playState !== 'paused' && Math.abs(Number(ref.currentTime ?? 0) - want) > 60) {
        setAll(want);
      }
    }
  };
  // nobody sees the wipe while the window is hidden or minimized: stop polling and
  // catch up once on return (the animations themselves are paused by the browser)
  let iv = 0;
  const start = () => {
    if (!iv) iv = window.setInterval(sync, 50);
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
  if (!document.hidden) start();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
  };
}

/**
 * GPU-composited wipe (WebView2 / any compositing engine), one layer pair per visual row:
 * a clipping layer slides in from the left while the fill inside it slides the other way,
 * so the fill stays put and only its visible part grows. rows run one after another (first
 * row fills, then the second), each at the same speed. all transform animations, i.e. pure
 * compositor work (no repaint per frame); the clipping layer has a soft mask on its
 * leading edge, so the edge is feathered
 */
function runTransformWipe(
  wrap: HTMLElement,
  fill: HTMLElement,
  span: number,
  pos: () => number
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
      // one feather wider than the row, so at the end of the row the feathered edge sits
      // past the last letter and the whole row is lit
      const full = row.w + lead + feather;
      const clipper = document.createElement('span');
      clipper.className = 'lyric-karaoke-clip';
      clipper.setAttribute('aria-hidden', 'true');
      clipper.style.cssText = `inset:auto;left:${left}px;top:${row.y0}px;width:${full}px;height:${row.y1 - row.y0}px;`;
      const copy = fill.cloneNode(true) as HTMLElement;
      copy.classList.add('lyric-karaoke-fill-moving');
      copy.style.cssText = `inset:auto;position:absolute;left:${-left}px;top:${-row.y0}px;width:${W}px;height:${H}px;`;
      clipper.appendChild(copy);
      wrap.appendChild(clipper);
      const timing: KeyframeAnimationOptions = {
        delay: row.t0 * durMs,
        duration: Math.max(1, (row.t1 - row.t0) * durMs),
        easing: 'linear',
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
    () => {}
  );
  return () => {
    stopSync();
    stopLayout();
    anims.forEach((a) => a.cancel());
    layers.forEach((l) => l.remove());
    fill.style.visibility = '';
  };
}

/** WebKitGTK paints in software on most Linux boxes: there the column wipe repaints less */
const useColumns =
  typeof navigator !== 'undefined' &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

type Props = {
  text: string;
  active: boolean;
  start: number;
  end: number;
  getProgress?: () => number;
};

export function LyricKaraokeText({ text, active: activeProp, start, end, getProgress }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  // light lyrics mode (settings, off by default): the line highlight stays, no wipe
  const light = useLightLyrics();
  // the wipe only runs while the line is actually on screen (lyrics rail scrolled, panel
  // closed, view covered by another page): an off-screen compositor animation still costs a
  // frame per vsync. it resumes at the audio position, so what you see is unchanged
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
  const active = activeProp && !light;
  const animate = active && onScreen;

  useEffect(() => {
    if (!animate) return;
    const el = wrapRef.current;
    if (!el) return;
    const span = Math.max(0.32, end - start);
    // karaoke wipe should start with the highlight, same late-bias as the active line
    // z lewej do prawej jak karaoke na weselu, tylko mniej wstydu
    const pos = () => (getProgress?.() ?? start) - 0.35 - start;

    const fill = el.querySelector<HTMLElement>('.lyric-karaoke-fill');
    if (fill && typeof fill.animate === 'function') {
      return useColumns
        ? runColumnWipe(el, fill, span, pos)
        : runTransformWipe(el, fill, span, pos);
    }

    let raf = 0;
    const tick = () => {
      const p = Math.max(0, Math.min(1, pos() / span));
      el.style.setProperty('--karaoke-p', `${(p * 100).toFixed(2)}%`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, start, end, getProgress]);

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
