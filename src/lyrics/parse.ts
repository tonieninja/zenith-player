export interface LyricsLine {
  time: number;
  text: string;
}

const BREAK_MARK = '♪';
// krótsza cisza między linijkami to oddech, nie przerwa instrumentalna
const BREAK_MIN_S = 5;
const BLANK = /^[♪♫*\-_.\s]*$/;

// pusta linijka to koniec wokalu: przed dłuższą przerwą wstawiamy ♪, żeby poprzednia linia zgasła
export function normalizeSynced(lines: LyricsLine[]): LyricsLine[] {
  const sorted = [...lines].sort((a, b) => a.time - b.time);
  const out: LyricsLine[] = [];
  let pause: number | null = null;
  for (const line of sorted) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (BLANK.test(text)) {
      const last = out[out.length - 1];
      if (last && pause == null && line.time - last.time >= 1) pause = line.time;
      continue;
    }
    if (pause != null && line.time - pause >= BREAK_MIN_S) {
      out.push({ time: pause, text: BREAK_MARK });
    }
    pause = null;
    const prev = out[out.length - 1];
    if (prev && prev.text === text && line.time - prev.time < 0.45) continue;
    // duet w jednym znaczniku: druga linijka nigdy nie zostałaby aktywna, więc łączymy obie
    if (prev && prev.time === line.time) {
      prev.text = `${prev.text} / ${text}`;
      continue;
    }
    out.push({ time: line.time, text });
  }
  if (pause != null) out.push({ time: pause, text: BREAK_MARK });
  return out;
}

function parseTimestamp(min: string, sec: string, frac?: string): number {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + f;
}

export function parseLrc(text: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  const rows = text.split(/\r?\n/);
  // dodatni [offset:] w LRC znaczy, że tekst ma wejść wcześniej
  const offset = Number(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(text)?.[1] ?? 0) / 1000;
  for (const row of rows) {
    const stamps = [...row.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!stamps.length) continue;
    const lyricText = row
      .replace(/\[[^\]]+\]/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    for (const match of stamps) {
      lines.push({
        time: Math.max(0, parseTimestamp(match[1], match[2], match[3]) - offset),
        text: lyricText,
      });
    }
  }
  return normalizeSynced(lines);
}

export function parseRichsync(text: string): LyricsLine[] {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    const lines: LyricsLine[] = [];
    for (const row of data) {
      const time = Number(row?.ts ?? row?.time?.total ?? row?.time);
      let lyricText = '';
      if (Array.isArray(row?.l)) {
        lyricText = row.l
          .map((w: { c?: string; text?: string }) => String(w?.c ?? w?.text ?? ''))
          .join('');
      } else {
        lyricText = String(row?.x ?? row?.text ?? '');
      }
      if (!Number.isFinite(time)) continue;
      lines.push({ time, text: lyricText });
      // pole te to koniec śpiewanej linii, po nim może zacząć się przerwa instrumentalna
      const end = Number(row?.te);
      if (Number.isFinite(end) && end > time) lines.push({ time: end, text: '' });
    }
    return normalizeSynced(lines);
  } catch {
    return [];
  }
}

export function parseMxmSubtitles(text: string): LyricsLine[] {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    const lines: LyricsLine[] = [];
    for (const row of data) {
      const time = Number(row?.time?.total ?? row?.ts ?? row?.time);
      if (Number.isFinite(time)) lines.push({ time, text: String(row?.text ?? row?.x ?? '') });
    }
    return normalizeSynced(lines);
  } catch {
    return [];
  }
}

export function parseMusixmatchSynced(body: string): LyricsLine[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('[') && trimmed.includes('{')) {
    const rich = parseRichsync(trimmed);
    if (rich.length) return rich;
    const mxm = parseMxmSubtitles(trimmed);
    if (mxm.length) return mxm;
  }
  return parseLrc(body);
}
