import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { PlaylistEntry } from './playlistManager';

export const SPOTIFY_REDIRECT_PORT = 8766;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SCOPES = 'playlist-modify-private playlist-modify-public';
const CLIENT_KEY = 'zenith_spotify_client_id';
const TOKEN_KEY = 'zenith_spotify_token';

export function getSpotifyClientId(): string {
  const saved = localStorage.getItem(CLIENT_KEY)?.trim();
  if (saved) return saved;
  return (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined)?.trim() || '';
}

export function setSpotifyClientId(id: string) {
  const v = id.trim();
  if (v) localStorage.setItem(CLIENT_KEY, v);
  else localStorage.removeItem(CLIENT_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function randomVerifier(len = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function authorizeUrl(clientId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

interface StoredToken {
  access: string;
  refresh: string;
  expires: number;
}

function loadToken(): StoredToken | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t?.access ? t : null;
  } catch {
    return null;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<StoredToken> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token)
    throw new Error(data.error_description || data.error || `token HTTP ${res.status}`);
  const prev = loadToken();
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || prev?.refresh || '',
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return token;
}

export function isSpotifyConnected(): boolean {
  return Boolean(loadToken());
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function connectSpotify(): Promise<void> {
  const clientId = getSpotifyClientId();
  if (!clientId) throw new Error('no client id');
  const verifier = randomVerifier();
  const state = randomVerifier(24);
  const wait = invoke<string>('spotify_wait_for_code', {
    port: SPOTIFY_REDIRECT_PORT,
    state,
    timeoutSecs: 300,
  });
  await openUrl(authorizeUrl(clientId, await pkceChallenge(verifier), state));
  const code = await wait;
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
}

async function accessToken(): Promise<string> {
  const t = loadToken();
  if (!t) throw new Error('not connected');
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) throw new Error('not connected');
  return (
    await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: getSpotifyClientId(),
    })
  ).access;
}

async function api(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get('retry-after') || 2);
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
    return api(path, init, attempt + 1);
  }
  if (res.status === 401 && attempt === 0) {
    const t = loadToken();
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...t, expires: 0 }));
    return api(path, init, 1);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data?.error?.message || `spotify HTTP ${res.status}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return data;
}

const FEAT = /\s*[([](feat\.?|ft\.?|with|prod\.?)[^)\]]*[)\]]/gi;
const NOISE =
  /\s*[([](official( music)? video|official audio|lyrics?( video)?|audio|visuali[sz]er|hd|4k|remaster(ed)?( \d{4})?)[)\]]/gi;

export function normalizeTitle(s: string): string {
  return s
    .replace(FEAT, '')
    .replace(NOISE, '')
    .replace(/\s+-\s+(remaster(ed)?( \d{4})?|single version|radio edit)$/i, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function splitArtists(s: string): string[] {
  return s
    .split(/\s*(?:,|&|•|\band\b|\bx\b|\bfeat\.?|\bft\.?)\s*/i)
    .map((a) => normalizeTitle(a))
    .filter(Boolean);
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  let total = 0;
  for (const [g, n] of A) {
    hit += Math.min(n, B.get(g) || 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return (2 * hit) / total;
}

export interface SpotifyCandidate {
  uri: string;
  name: string;
  artists: string[];
  durationMs: number;
}

export function scoreMatch(
  entry: Pick<PlaylistEntry, 'title' | 'artist' | 'durationSec'>,
  c: SpotifyCandidate
): number {
  const title = similarity(normalizeTitle(entry.title), normalizeTitle(c.name));
  const ours = splitArtists(entry.artist);
  const theirs = c.artists.map(normalizeTitle);
  let artist = 0;
  for (const a of ours) for (const b of theirs) artist = Math.max(artist, similarity(a, b));
  if (!ours.length) artist = 0.5;
  let dur = 0.5;
  if (entry.durationSec) {
    const diff = Math.abs(entry.durationSec - c.durationMs / 1000);
    dur = diff <= 3 ? 1 : diff <= 10 ? 0.7 : diff <= 30 ? 0.3 : 0;
  }
  return title * 0.55 + artist * 0.35 + dur * 0.1;
}

export const MATCH_THRESHOLD = 0.62;

export function pickBest(
  entry: PlaylistEntry,
  candidates: SpotifyCandidate[]
): { c: SpotifyCandidate; score: number } | null {
  let best: { c: SpotifyCandidate; score: number } | null = null;
  for (const c of candidates) {
    const score = scoreMatch(entry, c);
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}

async function searchCandidates(entry: PlaylistEntry): Promise<SpotifyCandidate[]> {
  const artist = splitArtists(entry.artist)[0] || '';
  const title = normalizeTitle(entry.title);
  const queries = [
    artist ? `track:${title} artist:${artist}` : `track:${title}`,
    `${title} ${artist}`.trim(),
  ];
  const out: SpotifyCandidate[] = [];
  for (const q of queries) {
    const data = await api(`/search?type=track&limit=8&q=${encodeURIComponent(q)}`);
    for (const t of data?.tracks?.items || []) {
      out.push({
        uri: t.uri,
        name: t.name,
        artists: (t.artists || []).map((a: any) => a.name),
        durationMs: t.duration_ms,
      });
    }
    if (out.length && pickBest(entry, out)) break;
  }
  return out;
}

export interface ExportResult {
  playlistUrl: string;
  matched: number;
  unmatched: PlaylistEntry[];
}

export async function exportToSpotify(
  name: string,
  description: string,
  entries: PlaylistEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<ExportResult> {
  const uris: string[] = [];
  const unmatched: PlaylistEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    try {
      const best = pickBest(entries[i], await searchCandidates(entries[i]));
      if (best) uris.push(best.c.uri);
      else unmatched.push(entries[i]);
    } catch (e) {
      if ((e as { status?: number }).status === 401) throw e;
      unmatched.push(entries[i]);
    }
    onProgress?.(i + 1, entries.length);
  }
  const me = await api('/me');
  const pl = await api(`/users/${encodeURIComponent(me.id)}/playlists`, {
    method: 'POST',
    body: JSON.stringify({
      name: name.slice(0, 100),
      description: description.slice(0, 300),
      public: false,
    }),
  });
  for (let i = 0; i < uris.length; i += 100) {
    const body = JSON.stringify({ uris: uris.slice(i, i + 100) });
    try {
      await api(`/playlists/${pl.id}/items`, { method: 'POST', body });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      await api(`/playlists/${pl.id}/tracks`, { method: 'POST', body });
    }
  }
  return {
    playlistUrl: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`,
    matched: uris.length,
    unmatched,
  };
}
