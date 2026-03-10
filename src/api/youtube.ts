import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { Language, translations } from '../i18n';
import { resolveFeedItem, bylineFromRuns } from '../utils/feed';
import {
  isAcceptableLyricsMatch,
  pickBestSyncedLyrics,
  scoreLyricsMatch,
  shouldShowEarlyPlain,
} from '../utils/lyricsMatch';
import {
  GENIUS_BROWSER_HEADERS,
  geniusHttpError,
  LYRICS_BROWSER_UA,
} from '../utils/lyricsProviders';
import { normalizeSynced, parseLrc, type LyricsLine } from '../utils/lyricsParse';
import { getMusixmatchLyrics as getMusixmatchTrackLyrics } from './musixmatch';

const DEFAULT_YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
let ytmKey = DEFAULT_YTM_KEY;

const ytmUrl = (action: string) =>
  `https://music.youtube.com/youtubei/v1/${action}?prettyPrint=false&key=${ytmKey}`;

const dateClientVersion = () => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `1.${y}${m}${day}.01.00`;
};

const CLIENT_BASE = {
  context: {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: dateClientVersion(),
    },
  },
};

export function applyInnertubeConfig(cfg?: {
  clientVersion?: string | null;
  apiKey?: string | null;
  innertubeVersion?: string | null;
  innertubeKey?: string | null;
}) {
  if (!cfg) return;
  const version = (cfg.clientVersion || cfg.innertubeVersion || '').trim();
  const key = (cfg.apiKey || cfg.innertubeKey || '').trim();
  if (version.startsWith('1.') && version.length >= 12) {
    CLIENT_BASE.context.client.clientVersion = version;
  }
  if (key.startsWith('AIza') && key.length >= 20) {
    ytmKey = key;
  }
}

const buildClientContext = (lang: Language) => {
  const isPl = lang === 'pl';
  const client: Record<string, string> = {
    ...CLIENT_BASE.context.client,
    hl: isPl ? 'pl' : 'en',
    gl: isPl ? 'PL' : 'US',
  };
  return {
    ...CLIENT_BASE,
    context: { client },
  };
};

const buildHeaders = (lang: Language) => ({
  'Content-Type': 'application/json',
  Origin: 'https://music.youtube.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language':
    lang === 'pl' ? 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9,pl;q=0.7',
});

let ytCookieCache: { cookie: string; ts: number } | null = null;
const YT_COOKIE_TTL = 45 * 1000;

export function clearAuthCache() {
  ytCookieCache = null;
}

async function getYtmCookie(): Promise<string> {
  if (ytCookieCache && Date.now() - ytCookieCache.ts < YT_COOKIE_TTL) return ytCookieCache.cookie;
  try {
    let cookie = await Promise.race([
      invoke<string>('get_ytm_cookies'),
      new Promise<string>((resolve) => window.setTimeout(() => resolve(''), 8000)),
    ]);
    const hasSapi = Boolean(extractSapisid(cookie));
    const hasPsid = cookie.includes('__Secure-1PSID=') || cookie.includes('__Secure-3PSID=');
    if (hasSapi && !hasPsid) {
      clearAuthCache();
      cookie = await Promise.race([
        invoke<string>('get_ytm_cookies'),
        new Promise<string>((resolve) => window.setTimeout(() => resolve(''), 8000)),
      ]);
    }
    ytCookieCache = { cookie: cookie || '', ts: Date.now() };
  } catch {
    ytCookieCache = { cookie: '', ts: Date.now() };
  }
  return ytCookieCache.cookie;
}

function cookieValue(cookie: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]+)`));
  const value = m?.[1]?.trim();
  return value ? value : null;
}

function extractSapisid(cookie: string): string | null {
  return (
    cookieValue(cookie, 'SAPISID') ||
    cookieValue(cookie, '__Secure-3PAPISID') ||
    cookieValue(cookie, '__Secure-1PAPISID')
  );
}

const YTM_ORIGIN = 'https://music.youtube.com';

export async function sapisidAuthorization(cookie: string, ts: number): Promise<string> {
  const parts: string[] = [];
  const sapi = cookieValue(cookie, 'SAPISID') || cookieValue(cookie, '__Secure-3PAPISID');
  if (sapi) parts.push(`SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapi} ${YTM_ORIGIN}`)}`);
  const p1 = cookieValue(cookie, '__Secure-1PAPISID');
  if (p1) parts.push(`SAPISID1PHASH ${ts}_${await sha1Hex(`${ts} ${p1} ${YTM_ORIGIN}`)}`);
  const p3 = cookieValue(cookie, '__Secure-3PAPISID');
  if (p3) parts.push(`SAPISID3PHASH ${ts}_${await sha1Hex(`${ts} ${p3} ${YTM_ORIGIN}`)}`);
  return parts.join(' ');
}

export async function isLoggedIn(): Promise<boolean> {
  return Boolean(extractSapisid(await getYtmCookie()));
}

let lastVerifyNetworkError = false;
let lastVerifyInconclusive = false;
export function lastSessionCheckWasNetworkError(): boolean {
  return lastVerifyNetworkError;
}
export function lastSessionCheckWasInconclusive(): boolean {
  return lastVerifyInconclusive;
}

function loggedInFlag(raw: string): '0' | '1' | null {
  const m = raw.match(/"key":"logged_in"\s*,\s*"value":\s*"(0|1)"/);
  return m ? (m[1] as '0' | '1') : null;
}

function responseSaysLoggedOut(raw: string): boolean {
  return loggedInFlag(raw) === '0';
}

function responseHasAccount(raw: string): boolean {
  return (
    raw.includes('activeAccountHeaderRenderer') ||
    raw.includes('accountItemRenderer') ||
    raw.includes('"accountItem"')
  );
}

function responseSaysLoggedIn(raw: string): boolean {
  if (responseSaysLoggedOut(raw)) return false;
  return loggedInFlag(raw) === '1' || responseHasAccount(raw);
}

export async function verifyYtmSession(lang: Language): Promise<boolean> {
  lastVerifyNetworkError = false;
  lastVerifyInconclusive = false;
  if (!(await isLoggedIn())) return false;
  const headers = await buildAuthHeaders(lang);
  if (!headers.Authorization) return false;
  try {
    const response = await fetchWithTimeout(
      ytmUrl('account/account_menu'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(buildClientContext(lang)),
      },
      6000
    );
    const raw = await response.text();
    if (responseSaysLoggedOut(raw)) return false;
    if (!response.ok) {
      if (response.status === 401) return false;
      if (response.status === 403) {
        lastVerifyInconclusive = true;
        return false;
      }
      lastVerifyNetworkError = true;
      return false;
    }
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      lastVerifyNetworkError = true;
      return false;
    }
    if (data && typeof data === 'object' && (data as { error?: unknown }).error) return false;
    return responseSaysLoggedIn(raw);
  } catch {
    lastVerifyNetworkError = true;
    return false;
  }
}

export async function resolveLoginState(lang: Language, force = false): Promise<boolean> {
  if (force) clearAuthCache();
  if (!(await isLoggedIn())) return false;
  return verifyYtmSession(lang);
}

export async function waitForLogin(lang: Language, attempts = 5, gapMs = 700): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    clearAuthCache();
    if (await resolveLoginState(lang)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildAuthHeaders(lang: Language): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...buildHeaders(lang) };
  try {
    const cookie = await getYtmCookie();
    const ts = Math.floor(Date.now() / 1000);
    const authorization = await sapisidAuthorization(cookie, ts);
    if (!authorization) return headers;
    headers.Cookie = cookie;
    headers.Authorization = authorization;
    headers['X-Origin'] = YTM_ORIGIN;
    headers['X-Goog-AuthUser'] = '0';
  } catch (err) {
    console.debug('youtube buildAuthHeaders', err);
  }
  return headers;
}

export interface Track {
  id: string;
  type: 'track' | 'album' | 'playlist' | 'artist' | 'profile' | 'podcast';
  title: string;
  artist: string;
  cover: string;
  coverSmall?: string;
  coverLarge?: string;
  durationSec?: number;
}

export interface Section {
  title: string;
  items: Track[];
}

export type { LyricsLine };

export interface LyricsFailure {
  provider: string;
  reason: string;
}

export interface LyricsResult {
  provider: string;
  text: string | null;
  synced?: LyricsLine[];
  matchScore?: number;
  failures?: LyricsFailure[];
  via?: string;
}

export type LyricsProvider =
  | 'Auto'
  | 'LRCLib'
  | 'Musixmatch'
  | 'YouTube Music'
  | 'LyricsGenius'
  | 'Lyrics.ovh';

export const MOOD_BROWSE_ID = 'FEmusic_moods_and_genres_category';
const BROWSE_PARAMS_SEP = '::';
const moodBrowse = (params: string) => `${MOOD_BROWSE_ID}${BROWSE_PARAMS_SEP}${params}`;

function splitBrowseId(id: string): { browseId: string; params?: string } {
  const at = id.indexOf(BROWSE_PARAMS_SEP);
  if (at < 0) return { browseId: id };
  return { browseId: id.slice(0, at), params: id.slice(at + BROWSE_PARAMS_SEP.length) };
}

export function moodBrowseIdFor(categoryId: string): string | null {
  const hit = [...MOODS_AND_MOMENTS, ...GENRES].find((c) => c.id === categoryId);
  return hit ? hit.browseId : null;
}

export const MOODS_AND_MOMENTS = [
  {
    id: 'chill',
    title: 'Chill',
    browseId: moodBrowse('ggMPOg1uX1JOQWZFeDByc2Jm'),
    color: '#4285F4',
  },
  {
    id: 'christmas',
    title: 'Christmas',
    browseId: moodBrowse('ggMPOg1uX280STVTNVQwRGZ0'),
    color: '#0F9D58',
  },
  {
    id: 'commute',
    title: 'Commute',
    browseId: moodBrowse('ggMPOg1uX044Z2o5WERLckpU'),
    color: '#F4B400',
  },
  {
    id: 'energize',
    title: 'Energize',
    browseId: moodBrowse('ggMPOg1uX2lRZUZiMnNrQnJW'),
    color: '#F4B400',
  },
  {
    id: 'feelgood',
    title: 'Feel good',
    browseId: moodBrowse('ggMPOg1uXzZQbDB5eThLRTQ3'),
    color: '#0F9D58',
  },
  {
    id: 'focus',
    title: 'Focus',
    browseId: moodBrowse('ggMPOg1uX0NvNGNhWThMYWRh'),
    color: '#9C27B0',
  },
  {
    id: 'gaming',
    title: 'Gaming',
    browseId: moodBrowse('ggMPOg1uX3NmUVV4Vzl3WGQ0'),
    color: '#009688',
  },
  {
    id: 'party',
    title: 'Party',
    browseId: moodBrowse('ggMPOg1uX2w1aW1CRDFTSUNo'),
    color: '#9C27B0',
  },
  {
    id: 'romance',
    title: 'Romance',
    browseId: moodBrowse('ggMPOg1uX1JCQnB2QXVYVEIz'),
    color: '#DB4437',
  },
  { id: 'sad', title: 'Sad', browseId: moodBrowse('ggMPOg1uX3NISTh4UmtWcFgz'), color: '#607D8B' },
  {
    id: 'sleep',
    title: 'Sleep',
    browseId: moodBrowse('ggMPOg1uX1MxaFQ3Z0JMZkN4'),
    color: '#673AB7',
  },
  {
    id: 'workout',
    title: 'Workout',
    browseId: moodBrowse('ggMPOg1uXzIxYkNac21YZ2Z0'),
    color: '#FF5722',
  },
];
