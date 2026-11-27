#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// wzrost na godzinę po rozgrzewce; większy to podejrzenie wycieku, bo zdrowa aplikacja trzyma płaską linię
export const DEFAULT_LIMITS = { ws_private_mb: 10, handles: 100 };

export function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
  return { cols, rows };
}

export function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// najmniejsze kwadraty; xs w sekundach, wynik w jednostkach y na godzinę
export function slopePerHour(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? (num / den) * 3600 : NaN;
}

export function summarize(text, { skipMin = 0, limits = DEFAULT_LIMITS } = {}) {
  const { cols, rows } = parseCsv(text);
  const kept = rows.filter((r) => Number(r.elapsed_s) >= skipMin * 60);
  const series = cols
    .filter((c) => c !== 'time' && c !== 'elapsed_s')
    .map((col) => {
      const pts = kept
        .map((r) => [Number(r.elapsed_s), num(r[col])])
        .filter(([, y]) => Number.isFinite(y));
      const sorted = pts.map(([, y]) => y).sort((a, b) => a - b);
      const slope = slopePerHour(
        pts.map(([x]) => x),
        pts.map(([, y]) => y)
      );
      const limit = limits[col];
      return {
        col,
        min: sorted[0],
        median: sorted.length ? median(sorted) : NaN,
        max: sorted.at(-1),
        slope,
        limit,
        leak: limit !== undefined && slope > limit,
      };
    });
  const xs = kept.map((r) => Number(r.elapsed_s));
  return {
    samples: kept.length,
    hours: xs.length > 1 ? (xs.at(-1) - xs[0]) / 3600 : 0,
    series,
    leak: series.some((s) => s.leak),
    // liczone też w rozgrzewce, bo zamknięta aplikacja to zły wynik niezależnie od chwili
    gone: rows.filter((r) => r.processes === '0').length,
  };
}

// pusta komórka to brak pomiaru, a Number('') dałoby zero
const num = (v) => (v === undefined || v.trim() === '' ? NaN : Number(v));

function main(args) {
  let file;
  let skipMin = 0;
  const limits = { ...DEFAULT_LIMITS };
  for (const a of args) {
    if (a.startsWith('--skip-min=')) skipMin = Number(a.slice(11));
    else if (a.includes('=')) limits[a.split('=')[0]] = Number(a.split('=')[1]);
    else file = a;
  }
  if (!file || !Number.isFinite(skipMin)) {
    console.error('usage: summary.mjs <file.csv> [--skip-min=10] [column=limitPerHour ...]');
    return 2;
  }
  const s = summarize(readFileSync(file, 'utf8'), { skipMin, limits });
  if (s.samples < 3) {
    console.error(`${file}: ${s.samples} samples after the first ${skipMin} min, need at least 3`);
    return 2;
  }
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const out = [
    `${file}: ${s.samples} samples over ${s.hours.toFixed(2)} h, first ${skipMin} min skipped` +
      (s.hours < 1 ? ' (short run, the slope is rough)' : ''),
    `${'column'.padEnd(20)}${['min', 'median', 'max', 'slope/h', 'limit/h'].map((h) => h.padStart(10)).join('')}  verdict`,
  ];
  for (const r of s.series) {
    const cells = [r.min, r.median, r.max].map((v) => fmt(v).padStart(10)).join('');
    const slope = (r.slope > 0 ? '+' : '') + fmt(r.slope, 2);
    const verdict = r.limit === undefined ? '' : r.leak ? 'LEAK?' : 'ok';
    out.push(
      `${r.col.padEnd(20)}${cells}${slope.padStart(10)}${fmt(r.limit, 0).padStart(10)}  ${verdict}`
    );
  }
  if (s.gone) out.push(`verdict: GONE, the app wasn't running in ${s.gone} samples`);
  else if (s.leak) out.push('verdict: LEAK? a series grows faster than its limit');
  else out.push('verdict: ok, no series over its limit');
  process.stdout.write(out.join('\n') + '\n');
  return s.gone || s.leak ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
