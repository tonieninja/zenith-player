import { fetch } from '@tauri-apps/plugin-http';
import { isAcceptableLyricsMatch, scoreLyricsMatch } from './match';
import { normalizeSynced, parseLrc, type LyricsLine } from './parse';

export interface SourceQuery {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  videoId?: string;
}

export interface SourceHit {
  synced?: LyricsLine[];
  text?: string;
  score?: number;
}

export interface Candidate {
  title: string;
  artist: string;
  durationSec?: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export async function getJson(
  url: string,
  name: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<any | null> {
  const res = await fetch(url, {
    method: init.method || 'GET',
    body: init.body,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${name} sent something that isn't JSON`);
  }
}

export function qs(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// najlepszy kandydat, który przechodzi te same progi co reszta źródeł, inaczej nic
export function pickCandidate<T>(
  q: SourceQuery,
  items: T[],
  read: (x: T) => Candidate
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const c = read(item);
    const query = { title: q.title, artist: q.artist, durationSec: q.durationSec };
    const cand = { title: c.title, artist: c.artist, durationSec: c.durationSec };
    const score = scoreLyricsMatch(query, cand);
    if (!isAcceptableLyricsMatch(query, cand, score)) continue;
    if (!best || score > best.score) best = { item, score };
  }
  return best;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// TTML podaje czas jako 12.3, 12.3s, 1:02.5 albo 0:01:02.5
export function ttmlTime(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().replace(/s$/, '');
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

// chórki (x-bg) wycinamy, bo w jednej linii zlewałyby się z głównym wokalem
export function parseTtml(xml: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  const body = xml.slice(Math.max(0, xml.indexOf('<body')));
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const begin = ttmlTime(/\bbegin="([^"]+)"/.exec(m[1])?.[1]);
    if (begin == null) continue;
    let text = '';
    let bgDepth = 0;
    let depth = 0;
    for (const tok of m[2].matchAll(/<\/?span\b[^>]*>|<br\s*\/?>|[^<]+|<[^>]*>/g)) {
      const t = tok[0];
      if (t.startsWith('<span')) {
        depth += 1;
        if (bgDepth || /x-bg/.test(t)) bgDepth += 1;
      } else if (t.startsWith('</span')) {
        depth = Math.max(0, depth - 1);
        if (bgDepth) bgDepth -= 1;
      } else if (/^<br/.test(t)) {
        if (!bgDepth) text += ' ';
      } else if (!t.startsWith('<') && !bgDepth) {
        text += t;
      }
    }
    text = decodeEntities(text).replace(/\s+/g, ' ').trim();
    if (text) lines.push({ time: begin, text });
  }
  return normalizeSynced(lines);
}

// chińskie serwisy wstawiają na początek linijki z autorami, w tekście nie mają czego szukać
const CREDIT =
  /^\s*(作词|作詞|作曲|编曲|編曲|制作人|製作人|监制|監製|混音|母带|母帶|录音|錄音|和声|和聲|吉他|贝斯|鼓|弦乐|出品|发行|發行|OP|SP|词|詞|曲|lyrics?\s*by|written\s*by|composed\s*by|produced\s*by|producer|composer|lyricist|arranged\s*by|mixed\s*by|mastered\s*by)\s*[:：]/i;

export function stripCredits(lines: LyricsLine[], title?: string): LyricsLine[] {
  const t = (title || '').trim().toLowerCase();
  return lines.filter((l, i) => {
    if (CREDIT.test(l.text)) return false;
    // pierwsza linijka bywa samym "Tytuł - Wykonawca"
    if (i === 0 && t && l.text.toLowerCase().startsWith(t) && /\s[-–]\s/.test(l.text)) {
      return false;
    }
    return true;
  });
}

export function base64Utf8(s: string): string {
  const bin = atob(s.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export async function getLyricsPlus(q: SourceQuery): Promise<SourceHit | null> {
  const url = `https://lyricsplus.binimum.org/v2/lyrics/get?${qs({
    title: q.title,
    artist: q.artist,
    album: q.album,
    duration: q.durationSec ? Math.round(q.durationSec) : undefined,
  })}`;
  const data = await getJson(url, 'LyricsPlus');
  if (!data || !Array.isArray(data.lyrics) || !data.lyrics.length) return null;
  const meta = data.metadata || {};
  let score: number | undefined;
  if (meta.title) {
    const hit = pickCandidate(q, [meta], (m) => ({
      title: String(m.title),
      artist: String(m.artist || m.artists?.join?.(', ') || q.artist),
      durationSec: ttmlTime(m.totalDuration) ?? undefined,
    }));
    if (!hit) return null;
    score = hit.score;
  }
  const lines = normalizeSynced(
    data.lyrics
      .map((l: any) => ({ time: Number(l?.time) / 1000, text: String(l?.text ?? '') }))
      .filter((l: LyricsLine) => Number.isFinite(l.time))
  );
  if (data.type === 'None' || lines.every((l) => l.time === 0)) {
    const text = lines.map((l) => l.text).join('\n');
    return text ? { text, score } : null;
  }
  return lines.length >= 2 ? { synced: lines, score } : null;
}

// Boidu trzyma teksty pod tytułem, wykonawcą i długością, bez długości nie ma czego pytać
export async function getBoidu(q: SourceQuery): Promise<SourceHit | null> {
  if (!q.durationSec) return null;
  const url = `https://lyrics-api.boidu.dev/getLyrics?${qs({
    s: q.title,
    a: q.artist,
    d: Math.round(q.durationSec),
  })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  // 401 i 404 znaczą tu, że takiej piosenki nie ma w bazie
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Boidu HTTP ${res.status}`);
  let data: any;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new Error("Boidu sent something that isn't JSON");
  }
  const raw = [data?.ttml, data?.syncedLyrics, data?.lrc, data?.lyrics].find(
    (v) => typeof v === 'string' && v.trim()
  ) as string | undefined;
  if (!raw) return null;
  const synced = raw.includes('<tt') ? parseTtml(raw) : parseLrc(raw);
  return synced.length >= 2 ? { synced } : null;
}

function unisonHit(data: any): SourceHit | null {
  const lyrics = data?.data?.lyrics;
  if (typeof lyrics !== 'string' || !lyrics.trim()) return null;
  const format = String(data?.data?.format || '').toLowerCase();
  if (format === 'plain') return { text: lyrics.trim() };
  const synced = lyrics.includes('<tt') ? parseTtml(lyrics) : parseLrc(lyrics);
  if (synced.length >= 2) return { synced };
  return { text: lyrics.trim() };
}

// najpierw po id filmu, bo społeczność wrzuca teksty pod konkretne nagranie
export async function getUnison(q: SourceQuery): Promise<SourceHit | null> {
  const base = 'https://unison.betterlyrics.org/lyrics';
  if (q.videoId) {
    const hit = unisonHit(await getJson(`${base}?${qs({ v: q.videoId })}`, 'Unison'));
    if (hit) return hit;
  }
  const url = `${base}?${qs({
    song: q.title,
    artist: q.artist,
    duration: q.durationSec ? Math.round(q.durationSec) : undefined,
  })}`;
  return unisonHit(await getJson(url, 'Unison'));
}
