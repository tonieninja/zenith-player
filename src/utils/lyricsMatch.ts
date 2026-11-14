export type LyricsMatchQuery = {
  title: string;
  artist: string;
  durationSec?: number | null;
};

export type LyricsMatchCandidate = {
  title: string;
  artist: string;
  durationSec?: number | null;
};

export function normalizeLyricsText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenOverlap(a: string, b: string): number {
  const as = new Set(a.split(' ').filter((w) => w.length > 1));
  const bs = new Set(b.split(' ').filter((w) => w.length > 1));
  if (!as.size || !bs.size) return 0;
  let hit = 0;
  for (const w of as) if (bs.has(w)) hit += 1;
  return hit / Math.max(as.size, bs.size);
}

export function titleSimilarity(queryTitle: string, candidateTitle: string): number {
  const t = normalizeLyricsText(queryTitle);
  const ct = normalizeLyricsText(candidateTitle);
  if (!t || !ct) return 0;
  if (ct === t) return 8;
  if (ct.includes(t) || t.includes(ct)) {
    const shorter = t.length < ct.length ? t : ct;
    if (shorter.length >= 8 || shorter.split(' ').filter(Boolean).length >= 2) return 4;
    return 1;
  }
  return Math.round(tokenOverlap(t, ct) * 5);
}

export function artistSimilarity(queryArtist: string, candidateArtist: string): number {
  const a = normalizeLyricsText(queryArtist);
  const ca = normalizeLyricsText(candidateArtist);
  if (!a || !ca) return 0;
  if (ca === a) return 7;
  if (ca.includes(a) || a.includes(ca)) return 4;
  return Math.round(tokenOverlap(a, ca) * 4);
}

export function durationDeltaSec(a?: number | null, b?: number | null): number | null {
  if (a == null || b == null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.abs(a - b);
}

export function durationClose(a?: number | null, b?: number | null, tol = 5): boolean {
  const d = durationDeltaSec(a, b);
  return d != null && d <= tol;
}

const VERSION_TAGS = [
  'live',
  'remix',
  'mixed',
  'acoustic',
  'instrumental',
  'karaoke',
  'cover',
  'sped up',
  'slowed',
  'nightcore',
  'demo',
  'orchestral',
  'unplugged',
];

export function versionTags(title: string): string[] {
  const t = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return VERSION_TAGS.filter((tag) => new RegExp(`\\b${tag}\\b`).test(t));
}

export function scoreLyricsMatch(query: LyricsMatchQuery, cand: LyricsMatchCandidate): number {
  const tScore = titleSimilarity(query.title, cand.title);
  const aScore = artistSimilarity(query.artist, cand.artist);
  let score = tScore + aScore;
  const wanted = versionTags(query.title);
  const extra = versionTags(cand.title).filter((tag) => !wanted.includes(tag));
  if (extra.length) score -= 4;
  const d = durationDeltaSec(query.durationSec, cand.durationSec);
  if (d != null) {
    if (d <= 2) score += 3;
    else if (d <= 5) score += 1;
    else if (d > 8 && d / Math.max(query.durationSec || 0, cand.durationSec || 0) > 0.12) {
      score -= 5;
    }
  }
  const words = normalizeLyricsText(query.title).split(' ').filter(Boolean);
  if (words.length <= 1 && tScore < 8) score -= 2;
  return score;
}

export function syncLengthFits(syncLength?: number | null, durationSec?: number | null): boolean {
  if (syncLength == null || durationSec == null) return true;
  if (!Number.isFinite(syncLength) || syncLength <= 0) return true;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return true;
  return Math.abs(syncLength - durationSec) <= Math.max(4, durationSec * 0.025);
}

export function minAcceptScore(title: string): number {
  const words = normalizeLyricsText(title).split(' ').filter(Boolean);
  if (words.length <= 1) return 10;
  if (words.length === 2) return 8;
  return 7;
}

export function isAcceptableLyricsMatch(
  query: LyricsMatchQuery,
  cand: LyricsMatchCandidate,
  score?: number
): boolean {
  const tScore = titleSimilarity(query.title, cand.title);
  const aScore = artistSimilarity(query.artist, cand.artist);
  const s = score ?? scoreLyricsMatch(query, cand);
  if (tScore < 3) return false;
  const d = durationDeltaSec(query.durationSec, cand.durationSec);
  const strongNames = tScore >= 7 && aScore >= 4;
  const maxDelta = strongNames ? 140 : 8;
  const maxRatio = strongNames ? 0.38 : 0.12;
  if (
    d != null &&
    d > maxDelta &&
    d / Math.max(query.durationSec || 0, cand.durationSec || 0) > maxRatio
  ) {
    return false;
  }
  const durOk = durationClose(query.durationSec, cand.durationSec, 5);
  if (aScore < 2 && !(tScore >= 7 && durOk)) return false;
  if (tScore < 4 && aScore < 4) return false;
  return s >= minAcceptScore(query.title);
}

export function pickBestSyncedLyrics<
  T extends { provider: string; matchScore?: number; synced?: { length: number } },
>(hits: T[]): T | null {
  if (!hits.length) return null;
  const bonus = (provider: string) =>
    provider === 'LRCLib' ? 200 : provider === 'Musixmatch' ? 80 : 0;
  const ranked = [...hits].sort((a, b) => {
    const qa = (a.matchScore ?? 0) * 1000 + bonus(a.provider) + Math.min(a.synced?.length || 0, 90);
    const qb = (b.matchScore ?? 0) * 1000 + bonus(b.provider) + Math.min(b.synced?.length || 0, 90);
    return qb - qa;
  });
  return ranked[0];
}

export function shouldShowEarlyPlain(res: {
  provider: string;
  matchScore?: number;
  text?: string | null;
  synced?: unknown[] | null;
}): boolean {
  if (res.synced && res.synced.length) return false;
  if (!res.text) return false;
  if (res.provider === 'Lyrics.ovh') return false;
  if (res.provider === 'YouTube Music') return true;
  return typeof res.matchScore === 'number' && res.matchScore > 0;
}
