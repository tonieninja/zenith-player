import { fetch } from '@tauri-apps/plugin-http';
import { ZenithPlugin } from './types';

const API = 'https://sponsor.ajay.app/api/skipSegments/';
// intro i outro zostają, bo w teledyskach to często prawdziwy wstęp albo wyciszenie piosenki
const CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
const RETRY_MS = 60_000;

export interface Segment {
  start: number;
  end: number;
  videoDuration: number;
}

const cache = new Map<string, Segment[]>();
// czas nieudanego zapytania zamiast timera, który przeżyłby wyłączenie wtyczki
const failedAt = new Map<string, number>();
const kept = new Set<Segment>();
let lastId = '';
let lastJump = Number.NaN;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseSegments(data: unknown, id: string): Segment[] {
  if (!Array.isArray(data)) return [];
  const video = data.find((v) => v && typeof v === 'object' && v.videoID === id);
  if (!video || !Array.isArray(video.segments)) return [];
  const out: Segment[] = [];
  for (const s of video.segments) {
    const [start, end] = Array.isArray(s?.segment) ? s.segment.map(Number) : [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 0.5) continue;
    if (s.actionType && s.actionType !== 'skip') continue;
    if (!CATEGORIES.includes(s.category)) continue;
    out.push({ start, end, videoDuration: Number(s.videoDuration) || 0 });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function segmentsUrl(prefix: string): string {
  const cats = encodeURIComponent(JSON.stringify(CATEGORIES));
  return `${API}${prefix}?categories=${cats}&actionType=skip`;
}

async function load(id: string) {
  // pusta lista od razu, żeby kolejne tyknięcia czasu nie wysyłały tego samego zapytania
  cache.set(id, []);
  if (cache.size > 300) {
    cache.clear();
    failedAt.clear();
    cache.set(id, []);
  }
  try {
    // serwer dostaje tylko 4 znaki hasha, więc nie wie, czego słuchasz
    const res = await fetch(segmentsUrl((await sha256Hex(id)).slice(0, 4)));
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`SponsorBlock HTTP ${res.status}`);
    cache.set(id, parseSegments(await res.json(), id));
  } catch {
    // offline nie może pytać co 250 ms, a po minucie warto spróbować jeszcze raz
    failedAt.set(id, Date.now());
  }
}

function usable(s: Segment, d: number): boolean {
  // segment oznaczony na innej wersji filmu przeskoczyłby nie ten fragment
  if (s.videoDuration > 0 && Math.abs(s.videoDuration - d) > 3) return false;
  return s.end - s.start < 0.9 * d && !kept.has(s);
}

/** Pozycja, na którą trzeba przeskoczyć, albo null; d = 0, gdy długość nie jest jeszcze pewna. */
export function sponsorBlockJump(id: string, t: number, d: number): number | null {
  if (!/^[\w-]{11}$/.test(id) || !(d > 0) || !Number.isFinite(t)) return null;
  if (id !== lastId) {
    lastId = id;
    lastJump = Number.NaN;
    kept.clear();
  }
  if (Date.now() - (failedAt.get(id) ?? Infinity) >= RETRY_MS) {
    failedAt.delete(id);
    cache.delete(id);
  }
  const segs = cache.get(id);
  if (!segs) {
    void load(id);
    return null;
  }
  for (const s of segs) {
    if (!usable(s, d) || t < s.start || t >= s.end - 0.3) continue;
    // koniec przy końcu utworu zostawia 0,25 s, żeby onEnded przeszedł do następnego normalnie
    lastJump = s.end >= d - 1 ? d - 0.25 : s.end;
    return lastJump;
  }
  return null;
}

export const sponsorBlockPlugin: ZenithPlugin = {
  id: 'sponsorblock',
  name: 'SponsorBlock',
  category: 'playback',
  description: 'Skips talking, skits and sponsor breaks in music videos.',
  defaultEnabled: false,
  onSeek(position) {
    // ktoś cofnął się do oznaczonego fragmentu, więc chce go usłyszeć do końca utworu
    if (position === lastJump) return;
    for (const s of cache.get(lastId) ?? []) {
      if (position >= s.start && position < s.end) kept.add(s);
    }
  },
};

export function resetSponsorBlockForTests() {
  cache.clear();
  failedAt.clear();
  kept.clear();
  lastId = '';
  lastJump = Number.NaN;
}
