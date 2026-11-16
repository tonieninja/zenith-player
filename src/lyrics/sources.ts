import { fetch } from '@tauri-apps/plugin-http';
import { isAcceptableLyricsMatch, scoreLyricsMatch, syncedDurationFits } from './match';
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

// kandydaci, którzy przechodzą te same progi co reszta źródeł, od najlepszego; te źródła dają tekst z czasami
export function rankCandidates<T>(
  q: SourceQuery,
  items: T[],
  read: (x: T) => Candidate
): { item: T; score: number }[] {
  const query = { title: q.title, artist: q.artist, durationSec: q.durationSec };
  const out: { item: T; score: number }[] = [];
  for (const item of items) {
    const c = read(item);
    if (!syncedDurationFits(q.durationSec, c.durationSec)) continue;
    const cand = { title: c.title, artist: c.artist, durationSec: c.durationSec };
    const score = scoreLyricsMatch(query, cand);
    if (isAcceptableLyricsMatch(query, cand, score)) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function pickCandidate<T>(
  q: SourceQuery,
  items: T[],
  read: (x: T) => Candidate
): { item: T; score: number } | null {
  return rankCandidates(q, items, read)[0] ?? null;
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
    if (!text) continue;
    lines.push({ time: begin, text });
    // pusty wpis na końcu linii pozwala normalizeSynced wykryć przerwę instrumentalną
    const end = ttmlTime(/\bend="([^"]+)"/.exec(m[1])?.[1]);
    if (end != null && end > begin) lines.push({ time: end, text: '' });
  }
  return normalizeSynced(lines);
}

// chińskie serwisy wstawiają na początek linijki z autorami, w tekście nie mają czego szukać
const CREDIT =
  /^\s*(作词|作詞|作曲|编曲|編曲|制作人|製作人|监制|監製|混音|母带|母帶|录音|錄音|和声|和聲|吉他|贝斯|鼓|弦乐|出品|发行|發行|OP|SP|词|詞|曲|lyrics?\s*by|written\s*by|composed\s*by|produced\s*by|producer|composer|lyricist|arranged\s*by|mixed\s*by|mastered\s*by)\s*[:：]/i;

// krótka etykieta, dwukropek i nazwisko, np. "Drums：David Stewart"
const LABELLED = /^[^:：]{1,24}\s*[:：]\s*\S/;
const isLabel = (text: string) =>
  LABELLED.test(text) && text.split(/[:：]/)[0].trim().split(/\s+/).length <= 4;
const isNameList = (text: string) => {
  const parts = text.split('/');
  return (
    parts.length >= 2 && parts.every((p) => /^\S+( \S+){0,3}$/.test(p.trim()) && p.trim() === p)
  );
};

export function stripCredits(lines: LyricsLine[], title?: string): LyricsLine[] {
  const t = (title || '').trim().toLowerCase();
  let head = true;
  return lines.filter((l, i) => {
    if (CREDIT.test(l.text)) return false;
    // pierwsza linijka bywa samym "Tytuł - Wykonawca"
    if (i === 0 && t && l.text.toLowerCase().startsWith(t) && /\s[-–]\s/.test(l.text)) {
      return false;
    }
    // blok opisów przed pierwszą prawdziwą linijką tekstu, też sama lista autorów "A/B/C"
    if (head && (isLabel(l.text) || isNameList(l.text))) return false;
    head = false;
    return true;
  });
}

export function base64Utf8(s: string): string {
  const bin = atob(s.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// pierwszy niepusty wynik wygrywa; błąd liczy się dopiero, gdy wszystkie zawiodły
export async function firstHit<T>(tries: Array<() => Promise<T | null>>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let left = tries.length;
    let error: unknown = null;
    let failed = 0;
    const settle = () => {
      if (--left > 0) return;
      if (failed === tries.length) reject(error);
      else resolve(null);
    };
    for (const run of tries) {
      run().then(
        (hit) => {
          if (hit) resolve(hit);
          else settle();
        },
        (e) => {
          error ??= e;
          failed += 1;
          settle();
        }
      );
    }
    if (!tries.length) resolve(null);
  });
}

// serwery mają osobne źródła i pamięć; główny po timeoucie źródeł potrafi zapamiętać 404 dla piosenki
const LYRICSPLUS_HOSTS = ['https://lyricsplus.binimum.org', 'https://lyricsplus.prjktla.my.id'];

export async function getLyricsPlus(q: SourceQuery): Promise<SourceHit | null> {
  const query = qs({
    title: q.title,
    artist: q.artist,
    album: q.album,
    duration: q.durationSec ? Math.round(q.durationSec) : undefined,
  });
  return firstHit(
    LYRICSPLUS_HOSTS.map(
      (host) => async () =>
        lyricsPlusHit(await getJson(`${host}/v2/lyrics/get?${query}`, 'LyricsPlus'), q)
    )
  );
}

function lyricsPlusHit(data: any, q: SourceQuery): SourceHit | null {
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
  const lines = stripCredits(
    normalizeSynced(
      data.lyrics
        .map((l: any) => ({ time: Number(l?.time) / 1000, text: String(l?.text ?? '') }))
        .filter((l: LyricsLine) => Number.isFinite(l.time))
    ),
    q.title
  );
  if (data.type === 'None' || lines.every((l) => l.time === 0)) {
    const text = lines.map((l) => l.text).join('\n');
    return text ? { text, score } : null;
  }
  return lines.length >= 2 && fitsTrack(lines, q) ? { synced: lines, score } : null;
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
  return synced.length >= 2 && fitsTrack(synced, q) ? { synced } : null;
}

// część źródeł sama wybiera utwór: tekst trwający dłużej niż piosenka jest z innej
function fitsTrack(synced: LyricsLine[], q: SourceQuery): boolean {
  return !q.durationSec || (synced.at(-1)?.time ?? 0) <= q.durationSec + 10;
}

function unisonHit(data: any, q: SourceQuery, byName: boolean): SourceHit | null {
  const entry = data?.data;
  const lyrics = entry?.lyrics;
  if (typeof lyrics !== 'string' || !lyrics.trim()) return null;
  let score: number | undefined;
  // po nazwie serwer zwraca najbliższy wpis, a ten bywa inną piosenką
  if (byName && entry.song) {
    const hit = pickCandidate(q, [entry], (e) => ({
      title: String(e.song),
      artist: String(e.artist || q.artist),
    }));
    if (!hit) return null;
    score = hit.score;
  }
  const format = String(entry.format || '').toLowerCase();
  if (format === 'plain') return { text: lyrics.trim(), score };
  const synced = lyrics.includes('<tt') ? parseTtml(lyrics) : parseLrc(lyrics);
  if (synced.length >= 2) return fitsTrack(synced, q) ? { synced, score } : null;
  return { text: lyrics.trim(), score };
}

// najpierw po id filmu, bo społeczność wrzuca teksty pod konkretne nagranie
export async function getUnison(q: SourceQuery): Promise<SourceHit | null> {
  const base = 'https://unison.betterlyrics.org/lyrics';
  if (q.videoId) {
    const hit = unisonHit(await getJson(`${base}?${qs({ v: q.videoId })}`, 'Unison'), q, false);
    if (hit) return hit;
  }
  const url = `${base}?${qs({
    song: q.title,
    artist: q.artist,
    duration: q.durationSec ? Math.round(q.durationSec) : undefined,
  })}`;
  return unisonHit(await getJson(url, 'Unison'), q, true);
}

const NETEASE_HEADERS = { Referer: 'https://music.163.com/' };

export async function getNetease(q: SourceQuery): Promise<SourceHit | null> {
  const found = await getJson('https://music.163.com/api/search/get', 'Netease', {
    method: 'POST',
    body: qs({ s: `${q.title} ${q.artist}`, type: 1, limit: 8, offset: 0 }),
    headers: { ...NETEASE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const songs: any[] = Array.isArray(found?.result?.songs) ? found.result.songs : [];
  const ranked = rankCandidates(q, songs, (s) => ({
    title: String(s?.name ?? ''),
    artist: (s?.artists ?? s?.ar ?? []).map((a: any) => a?.name).join(', '),
    durationSec: Number(s?.duration ?? s?.dt) / 1000 || undefined,
  }));
  for (const { item, score } of ranked.slice(0, 2)) {
    const data = await getJson(
      `https://music.163.com/api/song/lyric?${qs({ id: item.id, lv: 1, kv: 1, tv: -1 })}`,
      'Netease',
      { headers: NETEASE_HEADERS }
    );
    const lrc = data?.lrc?.lyric;
    if (typeof lrc !== 'string' || !lrc.trim()) continue;
    const synced = stripCredits(parseLrc(lrc), q.title);
    if (synced.length >= 2) return { synced, score };
  }
  return null;
}

const QQ_HEADERS = { Referer: 'https://y.qq.com/' };

export async function getQQMusic(q: SourceQuery): Promise<SourceHit | null> {
  const found = await getJson(
    `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?${qs({
      format: 'json',
      key: `${q.title} ${q.artist}`,
    })}`,
    'QQ Music',
    { headers: QQ_HEADERS }
  );
  const mids: string[] = (found?.data?.song?.itemlist ?? [])
    .map((s: any) => s?.mid)
    .filter((m: unknown): m is string => typeof m === 'string' && /^\w+$/.test(m));
  if (!mids.length) return null;
  // podpowiedzi nie mają długości, więc szczegóły bierzemy jednym zapytaniem
  const detail = await getJson(
    `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${qs({
      format: 'json',
      songmid: mids.slice(0, 6).join(','),
    })}`,
    'QQ Music',
    { headers: QQ_HEADERS }
  );
  const songs: any[] = Array.isArray(detail?.data) ? detail.data : [];
  const ranked = rankCandidates(q, songs, (s) => ({
    title: String(s?.name ?? s?.title ?? ''),
    artist: (s?.singer ?? []).map((a: any) => a?.name).join(', '),
    durationSec: Number(s?.interval) || undefined,
  }));
  for (const { item, score } of ranked.slice(0, 2)) {
    const data = await getJson(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${qs({
        songmid: item.mid,
        format: 'json',
        nobase64: 1,
      })}`,
      'QQ Music',
      { headers: QQ_HEADERS }
    );
    let lrc = typeof data?.lyric === 'string' ? data.lyric : '';
    // mimo nobase64 czasem i tak przychodzi base64
    if (lrc && !lrc.includes('[')) {
      try {
        lrc = base64Utf8(lrc);
      } catch {
        continue;
      }
    }
    const synced = stripCredits(parseLrc(lrc), q.title);
    if (synced.length >= 2) return { synced, score };
  }
  return null;
}

// wyszukiwarka Kugou co któreś zapytanie oddaje pustą listę, więc pytamy dwa razy
async function kugouSearch(q: SourceQuery): Promise<any[]> {
  const url = `https://songsearch.kugou.com/song_search_v2?${qs({
    keyword: `${q.title} ${q.artist}`,
    page: 1,
    pagesize: 8,
  })}`;
  for (let i = 0; i < 2; i++) {
    const data = await getJson(url, 'Kugou');
    const lists = data?.data?.lists;
    if (Array.isArray(lists) && lists.length) return lists;
  }
  return [];
}

const stripTags = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, '');

export async function getKugou(q: SourceQuery): Promise<SourceHit | null> {
  const ranked = rankCandidates(q, await kugouSearch(q), (s) => ({
    title: stripTags(s?.SongName),
    artist: stripTags(s?.SingerName),
    durationSec: Number(s?.Duration) || undefined,
  }));
  for (const { item, score } of ranked.slice(0, 2)) {
    const hash = String(item?.FileHash ?? '');
    if (!/^[0-9a-f]+$/i.test(hash)) continue;
    const found = await getJson(
      `https://krcs.kugou.com/search?${qs({ ver: 1, man: 'yes', client: 'mobi', hash })}`,
      'Kugou'
    );
    const cand = found?.candidates?.[0];
    if (!cand?.id || !cand?.accesskey) continue;
    const dl = await getJson(
      `https://lyrics.kugou.com/download?${qs({
        ver: 1,
        client: 'pc',
        id: cand.id,
        accesskey: cand.accesskey,
        fmt: 'lrc',
      })}`,
      'Kugou'
    );
    if (typeof dl?.content !== 'string' || !dl.content) continue;
    let lrc: string;
    try {
      lrc = base64Utf8(dl.content);
    } catch {
      continue;
    }
    const synced = stripCredits(parseLrc(lrc), q.title);
    if (synced.length >= 2) return { synced, score };
  }
  return null;
}
