export interface LyricsLine {
  time: number;
  text: string;
}

export function normalizeSynced(lines: LyricsLine[]): LyricsLine[] {
  const sorted = [...lines].sort((a, b) => a.time - b.time);
  const out: LyricsLine[] = [];
  for (const line of sorted) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text && line.time - prev.time < 0.45) continue;
    out.push({ time: line.time, text });
  }
  return out;
}

function parseTimestamp(min: string, sec: string, frac?: string): number {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + f;
}

export function parseLrc(text: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  const rows = text.split(/\r?\n/);
  for (const row of rows) {
    const stamps = [...row.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!stamps.length) continue;
    const lyricText = row
      .replace(/\[[^\]]+\]/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!lyricText || /^[♪♫*\-_.\s]+$/.test(lyricText)) continue;
    for (const match of stamps) {
      lines.push({
        time: parseTimestamp(match[1], match[2], match[3]),
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
      lyricText = lyricText.replace(/\s+/g, ' ').trim();
      if (Number.isFinite(time) && lyricText) lines.push({ time, text: lyricText });
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
      const lyricText = String(row?.text ?? row?.x ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (Number.isFinite(time) && lyricText) lines.push({ time, text: lyricText });
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
