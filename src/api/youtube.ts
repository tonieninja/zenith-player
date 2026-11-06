import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { Language, translations } from '../i18n';
import { resolveFeedItem } from '../utils/feedItem';
import {
  isAcceptableLyricsMatch,
  pickBestSyncedLyrics,
  scoreLyricsMatch,
  shouldShowEarlyPlain,
} from '../utils/lyricsMatch';
import {
  collectMusixmatchBundleUrls,
  extractMusixmatchSecretFromJs,
  GENIUS_BROWSER_HEADERS,
  geniusHttpError,
  LYRICS_BROWSER_UA,
  MXM_COMMUNITY_HEADERS,
  MXM_SECRET_MISSING,
} from '../utils/lyricsProviders';

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
      // innertube spits empty home / 400 if this version is old, rust refreshes it on boot
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

const buildClientContext = (lang: Language, cookie = '') => {
  const isPl = lang === 'pl';
  const visitor = cookie.match(/(?:^|;\s*)VISITOR_INFO1_LIVE=([^;]+)/)?.[1];
  const client: Record<string, string> = {
    ...CLIENT_BASE.context.client,
    hl: isPl ? 'pl' : 'en',
    gl: isPl ? 'PL' : 'US',
  };
  if (visitor) client.visitorData = visitor;
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

// google login cookies, same sapisidhash trick the real ytm tab uses
// rust pulls them from the webview2 profile so once you sign in
// library / private playlists actually work
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

function extractSapisid(cookie: string): string | null {
  const m =
    cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/) ||
    cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/);
  return m ? m[1] : null;
}

export async function isLoggedIn(): Promise<boolean> {
  return Boolean(extractSapisid(await getYtmCookie()));
}

/** cookie sitting there isnt enough, gotta check the ytm session actually works */
let lastVerifyNetworkError = false;
/** true when the last session check never got an answer from ytm (offline / proxy), not a rejection */
export function lastSessionCheckWasNetworkError(): boolean {
  return lastVerifyNetworkError;
}

export async function verifyYtmSession(lang: Language): Promise<boolean> {
  lastVerifyNetworkError = false;
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
    if (!response.ok) return false;
    const data = JSON.parse(await response.text());
    if (data?.error) return false;
    const raw = JSON.stringify(data);
    if (raw.includes('"key":"logged_in","value":"0"')) return false;
    return (
      raw.includes('accountItem') ||
      raw.includes('musicMultiSelectMenuItem') ||
      raw.includes('accountSettings') ||
      raw.includes('multiPageMenuRenderer')
    );
  } catch {
    lastVerifyNetworkError = true;
    return false;
  }
}

/** for the signed-in badge, sapisid leftover after logout is a liar */
export async function resolveLoginState(lang: Language, force = false): Promise<boolean> {
  if (force) clearAuthCache();
  if (!(await isLoggedIn())) return false;
  return verifyYtmSession(lang);
}

/** 2fa cookies take a second to land so we poke a few times */
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

/** signed out = plain headers, signed in = cookie + sapisidhash */
async function buildAuthHeaders(lang: Language): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...buildHeaders(lang) };
  try {
    const cookie = await getYtmCookie();
    const sapisid = extractSapisid(cookie);
    if (!sapisid) return headers;
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${sapisid} https://music.youtube.com`);
    headers.Cookie = cookie;
    headers.Authorization = `SAPISIDHASH ${ts}_${hash}`;
    headers['X-Origin'] = 'https://music.youtube.com';
    headers['X-Goog-AuthUser'] = '0';
    const visitor =
      cookie.match(/(?:^|;\s*)VISITOR_INFO1_LIVE=([^;]+)/)?.[1] ||
      cookie.match(/(?:^|;\s*)VISITOR_INFO1_LIVE=([^;]+)/)?.[1];
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
  } catch {
    /* no cookies, whatever */
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

export interface LyricsLine {
  time: number;
  text: string;
}

export interface LyricsFailure {
  provider: string;
  reason: string;
}

export interface LyricsResult {
  provider: string;
  text: string | null;
  synced?: LyricsLine[];
  /** how close title/artist is, pick the right song not the longest lrc dump */
  matchScore?: number;
  /** if nobody had lyrics, why each one ate shit */
  failures?: LyricsFailure[];
}

export type LyricsProvider =
  | 'Auto'
  | 'LRCLib'
  | 'Musixmatch'
  | 'YouTube Music'
  | 'LyricsGenius'
  | 'Lyrics.ovh';

/**
 * youtube music has no per-mood browse ids, every mood/genre page is the same
 * FEmusic_moods_and_genres_category browse plus an opaque params blob.
 * we pack both into one string so the rest of the app can keep passing a single id
 */
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

export const GENRES = [
  {
    id: 'african',
    title: 'African',
    browseId: moodBrowse('ggMPOg1uX0UzWGxlRE5jMDVk'),
    color: '#0F9D58',
  },
  {
    id: 'arabic',
    title: 'Arabic',
    browseId: moodBrowse('ggMPOg1uX3VOQWxsblVZTFNE'),
    color: '#FF9800',
  },
  {
    id: 'autumn',
    title: 'Autumn',
    browseId: moodBrowse('ggMPOg1uXzl4dDJmbUJXVGVU'),
    color: '#795548',
  },
  {
    id: 'blues',
    title: 'Blues',
    browseId: moodBrowse('ggMPOg1uX2NXUkgxdW0zUHJp'),
    color: '#2196F3',
  },
  {
    id: 'bollywood',
    title: 'Bollywood & Indian',
    browseId: moodBrowse('ggMPOg1uX0JrcUJGUHhxaTFV'),
    color: '#9C27B0',
  },
  {
    id: 'classical',
    title: 'Classical',
    browseId: moodBrowse('ggMPOg1uX1N4VmduTmdUR3dm'),
    color: '#E0E0E0',
  },
  {
    id: 'country',
    title: 'Country & Americana',
    browseId: moodBrowse('ggMPOg1uX1RXcFlyZEpRb1d3'),
    color: '#2196F3',
  },
  {
    id: 'dance',
    title: 'Dance & electronic',
    browseId: moodBrowse('ggMPOg1uX1NPTld3SDN3WGs4'),
    color: '#00BCD4',
  },
  {
    id: 'decades',
    title: 'Decades',
    browseId: moodBrowse('ggMPOg1uX1V4cTVVT0JjY0xI'),
    color: '#4CAF50',
  },
  {
    id: 'family',
    title: 'Family',
    browseId: moodBrowse('ggMPOg1uXzMyY3J2SGM0bVh5'),
    color: '#03A9F4',
  },
  {
    id: 'folk',
    title: 'Folk & acoustic',
    browseId: moodBrowse('ggMPOg1uXzBTRFBmQ3N4b0R6'),
    color: '#00E676',
  },
  {
    id: 'hiphop',
    title: 'Hip-hop',
    browseId: moodBrowse('ggMPOg1uX2E4aVJuU05GOVQ0'),
    color: '#FF5722',
  },
  {
    id: 'indie',
    title: 'Indie & alternative',
    browseId: moodBrowse('ggMPOg1uX21NWWpBbU01SDgy'),
    color: '#9E9E9E',
  },
  {
    id: 'jpop',
    title: 'J-Pop',
    browseId: moodBrowse('ggMPOg1uXzAwSjVITDBZckJR'),
    color: '#E91E63',
  },
  { id: 'jazz', title: 'Jazz', browseId: moodBrowse('ggMPOg1uX3lPcDFRaE9wM1BS'), color: '#3F51B5' },
  {
    id: 'kpop',
    title: 'K-Pop',
    browseId: moodBrowse('ggMPOg1uX0JrbjBDOFFPSzJW'),
    color: '#AB47BC',
  },
  {
    id: 'latin',
    title: 'Latin',
    browseId: moodBrowse('ggMPOg1uX29wWTRjMHV1dWN5'),
    color: '#FFC107',
  },
  {
    id: 'mandopop',
    title: 'Mandopop & cantopop',
    browseId: moodBrowse('ggMPOg1uX2hXVUQwc0JTNXlE'),
    color: '#F44336',
  },
  {
    id: 'metal',
    title: 'Metal',
    browseId: moodBrowse('ggMPOg1uXzdlSXhKZ0hMV1Z4'),
    color: '#9E9E9E',
  },
  { id: 'pop', title: 'Pop', browseId: moodBrowse('ggMPOg1uX1BmNzc2V2p0YXJ5'), color: '#E040FB' },
  {
    id: 'rnb',
    title: 'R&B & soul',
    browseId: moodBrowse('ggMPOg1uX2JxQ2hxc2J5UFhR'),
    color: '#7E57C2',
  },
  {
    id: 'reggae',
    title: 'Reggae & caribbean',
    browseId: moodBrowse('ggMPOg1uX1JUc2lFcDFuUUth'),
    color: '#FFEB3B',
  },
  { id: 'rock', title: 'Rock', browseId: moodBrowse('ggMPOg1uXzJKTm5jUEZ5Uzlu'), color: '#F44336' },
  {
    id: 'soundtracks',
    title: 'Soundtracks & musicals',
    browseId: moodBrowse('ggMPOg1uX2tWZXBsRm05cHNR'),
    color: '#00BCD4',
  },
];

const imageCache = new Map<string, number>();
const browseCache = new Map<string, { data: Section[]; ts: number }>();
const librarySectionCache = new Map<string, { at: number; sections: Section[] }>();
const searchCache = new Map<string, { data: Section[]; ts: number }>();
const IMAGE_CACHE_LIMIT = 12;
const BROWSE_CACHE_LIMIT = 6;
const SEARCH_CACHE_LIMIT = 8;
const IMAGE_CACHE_TTL = 30 * 60 * 1000;
const YTIMG_BASE = 'https://i.ytimg.com/vi/';

function pruneOldest<T>(cache: Map<string, T>, limit: number) {
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function preloadImage(url: string): Promise<void> {
  if (!url) return Promise.resolve();
  const cached = imageCache.get(url);
  if (cached && Date.now() - cached < IMAGE_CACHE_TTL) return Promise.resolve();
  if (cached) imageCache.delete(url);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.onload = () => {
      imageCache.set(url, Date.now());
      pruneOldest(imageCache, IMAGE_CACHE_LIMIT);
      resolve();
    };
    img.onerror = () => {
      if (url.includes('maxresdefault')) {
        const fallback = url.replace('maxresdefault', 'hqdefault');
        const img2 = new Image();
        img2.decoding = 'async';
        img2.fetchPriority = 'low';
        img2.onload = () => {
          imageCache.set(fallback, Date.now());
          pruneOldest(imageCache, IMAGE_CACHE_LIMIT);
          resolve();
        };
        img2.onerror = reject;
        img2.src = fallback;
      } else {
        reject(new Error('img load failed'));
      }
    };
    img.src = url;
  });
}

export function prefetchCovers(tracks: Track[]) {
  tracks.slice(0, 1).forEach((t) => {
    preloadImage(t.coverSmall || t.cover).catch(() => {});
  });
}

export function clearCaches() {
  imageCache.clear();
  browseCache.clear();
  searchCache.clear();
  lyricsCache.clear();
}

/** dump home/explore cache after login so it isnt the logged-out leftover */
export function clearHomeBrowseCache() {
  for (const key of browseCache.keys()) {
    if (
      key.startsWith('FEmusic_home:') ||
      key.startsWith('FEmusic_explore:') ||
      key.startsWith('FEmusic_new_releases:')
    ) {
      browseCache.delete(key);
    }
  }
}

/** drop cached library pages so the next read shows a write we just made */
export function invalidateLibraryCache() {
  for (const key of browseCache.keys()) {
    if (
      key.startsWith('FEmusic_liked_') ||
      key.startsWith('FEmusic_library_') ||
      key.startsWith('FEmusic_history')
    ) {
      browseCache.delete(key);
    }
  }
  librarySectionCache.clear();
}

// youtube music keeps listing a deleted / renamed playlist for a while after the write
// succeeded; these local overrides hide that lag (keyed by the plain playlist id)
const PLAYLIST_OVERRIDE_MS = 10 * 60 * 1000;
const deletedPlaylists = new Map<string, number>();
const renamedPlaylists = new Map<string, { title: string; ts: number }>();

/** apply recent local deletes/renames to a list of library items */
export function applyPlaylistOverrides<T extends { id: string; title: string }>(
  list: T[],
  now = Date.now()
): T[] {
  const out: T[] = [];
  for (const item of list) {
    const plain = toPlainPlaylistId(item.id);
    const del = deletedPlaylists.get(plain);
    if (del && now - del < PLAYLIST_OVERRIDE_MS) continue;
    const ren = renamedPlaylists.get(plain);
    out.push(ren && now - ren.ts < PLAYLIST_OVERRIDE_MS ? { ...item, title: ren.title } : item);
  }
  return out;
}

export function rememberPlaylistDeleted(id: string, now = Date.now()) {
  deletedPlaylists.set(toPlainPlaylistId(id), now);
  renamedPlaylists.delete(toPlainPlaylistId(id));
}

export function rememberPlaylistRenamed(id: string, title: string, now = Date.now()) {
  renamedPlaylists.set(toPlainPlaylistId(id), { title, ts: now });
}

async function invokeWithTimeout<T>(
  cmd: string,
  args?: Record<string, unknown>,
  ms = 15000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<T>(cmd, args),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`invoke ${cmd} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getOptimizedCover(
  url: string | undefined,
  size: 'small' | 'medium' | 'large'
): string {
  if (!url) return '';
  if (url.includes('ui-avatars')) {
    const sz = size === 'small' ? 120 : size === 'medium' ? 360 : 540;
    return url.replace('size=540', `size=${sz}`);
  }
  let u = url;
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.includes('ytimg.com/vi')) {
    const res = size === 'small' ? 'mqdefault' : 'hqdefault';
    return u.replace(/\/[a-z0-9_]+\.jpg(\?.*)?$/i, `/${res}.jpg`);
  }
  const px = size === 'small' ? 120 : size === 'medium' ? 226 : 544;
  if (/=w\d+-h\d+/i.test(u)) {
    return u.replace(/=w\d+-h\d+/i, `=w${px}-h${px}`);
  }
  if (/=s\d+/i.test(u)) {
    return u.replace(/=s\d+/i, `=s${px}`);
  }
  return u;
}

export async function getHome(lang: Language): Promise<Section[]> {
  // leave ytm's shelf order alone, they already put quick picks etc where they want
  return await fetchBrowse('FEmusic_home', lang);
}

export interface HomeFeed {
  sections: Section[];
  quickPicks: Track[];
}

const QUICK_PICK_TITLES = ['quick picks', 'szybkie wybory'];

/**
 * one home fetch, peel quick picks off the top so the carousel and the rest
 * dont come from two different responses and randomly vanish
 */
export async function getHomeFeed(lang: Language): Promise<HomeFeed> {
  let sections = await fetchBrowse('FEmusic_home', lang);
  if (sections.length === 0) {
    const landing = await fetchBrowse('FEmusic_library_landing', lang);
    if (landing.length) sections = landing;
  }
  const qpIndex = sections.findIndex((s) =>
    QUICK_PICK_TITLES.some((k) => s.title.toLowerCase().includes(k))
  );
  if (qpIndex >= 0) {
    const quickPicks = sections[qpIndex].items.filter((i) => i.type === 'track').slice(0, 16);
    const rest = sections.filter((_, i) => i !== qpIndex);
    return { sections: rest, quickPicks };
  }
  // no quick picks shelf, just grab tracks then albums and call it a day
  const quickPicks: Track[] = [];
  const seen = new Set<string>();
  const pushItem = (item: Track) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    quickPicks.push(item);
  };
  for (const section of sections) {
    for (const item of section.items) {
      if (item.type === 'track') pushItem(item);
      if (quickPicks.length >= 12) break;
    }
    if (quickPicks.length >= 12) break;
  }
  if (quickPicks.length < 6) {
    for (const section of sections) {
      for (const item of section.items) {
        if (item.type === 'album' || item.type === 'playlist') pushItem(item);
        if (quickPicks.length >= 12) break;
      }
      if (quickPicks.length >= 12) break;
    }
  }
  return { sections, quickPicks };
}

function orderExploreSectionsData(sections: Section[]): Section[] {
  const groups = [
    ['new album', 'nowe albumy', 'singles', 'single', 'new release', 'nowości'],
    ['trending', 'trendy', 'na czasie', 'chart', 'charts', 'top'],
    ['new music video', 'nowe teledyski', 'music video', 'teledyski'],
  ];
  return [...sections]
    .map((section, index) => {
      const title = section.title.toLowerCase();
      const priority = groups.findIndex((g) => g.some((k) => title.includes(k)));
      return { section, index, priority: priority === -1 ? groups.length : priority };
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((e) => e.section);
}

export async function getExplore(lang: Language): Promise<Section[]> {
  let explore = await fetchBrowse('FEmusic_explore', lang);
  if (explore.length === 0) {
    explore = await fetchBrowse('FEmusic_new_releases', lang);
  }
  const merged = dedupeSections(explore);
  return orderExploreSectionsData(merged.filter((s) => s.items.length > 0));
}

export async function getNewReleasesAlbums(lang: Language): Promise<Track[]> {
  try {
    const sections = await fetchBrowse('FEmusic_new_releases', lang);
    const all = sections.flatMap((s) => s.items);
    const unique = new Map<string, Track>();
    for (const t of all) if (!unique.has(t.id)) unique.set(t.id, t);
    return Array.from(unique.values()).slice(0, 80);
  } catch {
    return [];
  }
}

export async function getNewReleasesVideos(lang: Language): Promise<Track[]> {
  try {
    const sections = await fetchBrowse('FEmusic_new_releases', lang);
    const videoKeywords = ['video', 'teledysk', 'clip', 'wideo'];
    const videoSections = sections.filter((s) =>
      videoKeywords.some((k) => s.title.toLowerCase().includes(k))
    );
    const source = videoSections.length > 0 ? videoSections : sections;
    const all = source.flatMap((s) => s.items);
    const unique = new Map<string, Track>();
    for (const t of all) if (!unique.has(t.id)) unique.set(t.id, t);
    return Array.from(unique.values()).slice(0, 60);
  } catch {
    return [];
  }
}

export async function getQuickPicks(lang: Language): Promise<Track[]> {
  try {
    return (await getHomeFeed(lang)).quickPicks;
  } catch {
    return [];
  }
}

export async function getMoodPlaylist(browseId: string, lang: Language): Promise<Section[]> {
  try {
    return await fetchBrowse(browseId, lang);
  } catch {
    return [];
  }
}

// home comes in chunks, first browse is like 4 shelves then you paginate
// two token shapes out there, the new continuationCommand one and the old
// nextContinuationData thing, we grab both
function findContinuationToken(node: any): string | null {
  let found: string | null = null;
  const walk = (n: any) => {
    if (!n || found) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== 'object') return;
    const modern = n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof modern === 'string' && modern) {
      found = modern;
      return;
    }
    const legacy = n.nextContinuationData?.continuation;
    if (typeof legacy === 'string' && legacy) {
      found = legacy;
      return;
    }
    Object.values(n).forEach(walk);
  };
  walk(node);
  return found;
}

function dedupeSections(sections: Section[]): Section[] {
  const seen = new Set<string>();
  return sections.filter((s) => {
    const key = s.title.toLowerCase().trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** abortcontroller so hung fetches actually die */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 14000
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/** signed-in browse that hands back the raw json, for pages that need fields the shelf parser drops */
export async function ytmBrowseRaw(
  body: { browseId?: string; continuation?: string },
  lang: Language
): Promise<any> {
  const response = await fetchWithTimeout(ytmUrl('browse'), {
    method: 'POST',
    headers: await buildAuthHeaders(lang),
    body: JSON.stringify({ ...buildClientContext(lang), ...body }),
  });
  if (!response.ok) throw new Error(`browse HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

export { findContinuationToken };

async function fetchPlaylistContinuation(
  token: string,
  lang: Language
): Promise<{ data: unknown; next: string | null }> {
  const response = await fetchWithTimeout(ytmUrl('browse'), {
    method: 'POST',
    headers: await buildAuthHeaders(lang),
    body: JSON.stringify({ ...buildClientContext(lang), continuation: token }),
  });
  const data = JSON.parse(await response.text());
  return { data, next: findContinuationToken(data) };
}

// used to share inflight browse by id, then one hung promise froze tab switches
// now every call is its own thing with a hard timeout
async function fetchBrowse(browseId: string, lang: Language): Promise<Section[]> {
  const cookie = await getYtmCookie();
  const authed = extractSapisid(cookie) ? '1' : '0';
  const cacheKey = `${browseId}:${lang}:${authed}`;
  const cached = browseCache.get(cacheKey);
  const ttl =
    browseId.startsWith('FEmusic_home') || browseId.startsWith('FEmusic_explore') ? 180000 : 120000;
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  return Promise.race([
    fetchBrowseUncached(browseId, lang, cacheKey),
    new Promise<Section[]>((resolve) => window.setTimeout(() => resolve([]), 14000)),
  ]).catch(() => [] as Section[]);
}

async function fetchBrowseUncached(
  rawBrowseId: string,
  lang: Language,
  cacheKey: string
): Promise<Section[]> {
  const { browseId, params } = splitBrowseId(rawBrowseId);
  const isPl = lang === 'pl';
  const t = translations[lang];

  const store = (result: Section[]) => {
    browseCache.set(cacheKey, { data: result, ts: Date.now() });
    pruneOldest(browseCache, BROWSE_CACHE_LIMIT);
    return result;
  };

  const parsePayload = (data: unknown): Section[] => {
    if (!data || typeof data !== 'object') return [];
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.zenithSections)) {
      const sections = (o.zenithSections as Section[]).filter(
        (s) => s?.title && Array.isArray(s.items) && s.items.length > 0
      );
      if (sections.length) return dedupeSections(sections);
    }
    if (o.error) return [];
    let result = parseShelves(data, t);
    if (!result.length && browseId === 'FEmusic_home') {
      result = parseRichHome(data, t);
    }
    return dedupeSections(result);
  };

  const isLibrary =
    browseId.includes('library') ||
    browseId.includes('liked') ||
    browseId.startsWith('FEmusic_library') ||
    browseId.startsWith('FEmusic_liked');

  try {
    if (!isLibrary) {
      const rawText = await invokeWithTimeout<string>(
        'ytm_browse',
        {
          browseId,
          hl: isPl ? 'pl' : 'en',
          gl: isPl ? 'PL' : 'US',
          params: params ?? null,
        },
        12000
      );
      const result = parsePayload(JSON.parse(rawText));
      if (result.length) return store(result);
    }
  } catch (rustErr) {
    console.warn('[browse] rust path failed', browseId, rustErr);
  }

  const headers = await buildAuthHeaders(lang);
  const cookie = headers.Cookie ?? '';
  try {
    const response = await fetchWithTimeout(
      ytmUrl('browse'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...buildClientContext(lang, cookie),
          browseId,
          ...(params ? { params } : {}),
        }),
      },
      8000
    );
    const rawText = await response.text();
    if (response.ok) {
      const json = JSON.parse(rawText);
      if (isLibrary) libraryContinuations.set(cacheKey, findContinuationToken(json));
      const result = parsePayload(json);
      if (result.length) return store(result);
    } else {
      console.warn('[browse]', browseId, 'HTTP', response.status, rawText.slice(0, 200));
    }
  } catch (error) {
    console.warn('[browse] fetch failed', browseId, error);
  }

  return [];
}

export async function searchMusic(query: string, lang: Language): Promise<Section[]> {
  const q = query.trim();
  if (!q) return [];
  const cacheKey = `${q.toLowerCase()}:${lang}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60000) return cached.data;

  const t = translations[lang];
  const SONGS_PARAMS = 'EgWKAQIIAWoKEAMQBBAJEAoQBQ==';

  const run = async (params?: string): Promise<Section[]> => {
    const body: Record<string, unknown> = { ...buildClientContext(lang), query: q };
    if (params) body.params = params;
    const response = await fetchWithTimeout(
      ytmUrl('search'),
      {
        method: 'POST',
        headers: await buildAuthHeaders(lang),
        body: JSON.stringify(body),
      },
      10000
    );
    if (!response.ok) return [];
    const data = JSON.parse(await response.text());
    return parseShelves(data, t);
  };

  try {
    const [mixed, songs] = await Promise.all([run(), run(SONGS_PARAMS)]);
    const merged = mergeSearchSections(mixed, songs, t);
    if (merged.length > 0) {
      searchCache.set(cacheKey, { data: merged, ts: Date.now() });
      pruneOldest(searchCache, SEARCH_CACHE_LIMIT);
      return merged;
    }
    const fallback = await searchFallback(q, t);
    if (fallback.length > 0) {
      searchCache.set(cacheKey, { data: fallback, ts: Date.now() });
      pruneOldest(searchCache, SEARCH_CACHE_LIMIT);
    }
    return fallback;
  } catch {
    return await searchFallback(q, t);
  }
}

function mergeSearchSections(a: Section[], b: Section[], t: TranslationBundle): Section[] {
  const out: Section[] = [];
  const seenTitles = new Set<string>();
  const seenIds = new Set<string>();
  const push = (section: Section) => {
    const items = section.items.filter((item) => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });
    if (!items.length) return;
    const title = section.title || t.searchResults;
    if (seenTitles.has(title)) {
      const existing = out.find((s) => s.title === title);
      if (existing) existing.items.push(...items);
      return;
    }
    seenTitles.add(title);
    out.push({ title, items });
  };
  a.forEach(push);
  b.forEach(push);
  return out;
}

const inflightStreams = new Map<string, Promise<string | null>>();

function normalizeStreamUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const line = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('http://') || s.startsWith('https://'));
  if (!line) return null;
  // 127.0.0.1 proxy urls are fine to play
  // localhost to nasz, googlevideo to juz loteria
  if (line.startsWith('http://127.0.0.1/') || line.startsWith('http://localhost/')) {
    return line;
  }
  return line;
}

function isYoutubeVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** backend worst case: 2 yt-dlp runs (25s cap each) + 2 innertube clients + 1 last-resort yt-dlp run */
const STREAM_INVOKE_TIMEOUT_MS = 125_000;

export async function getAudioStream(
  videoId: string,
  _lang: Language,
  fresh = false
): Promise<string | null> {
  if (!videoId?.trim() || !isYoutubeVideoId(videoId)) return null;

  if (!fresh) {
    const existing = inflightStreams.get(videoId);
    if (existing) return existing;
  }

  const task = (async () => {
    // the backend already walks yt-dlp (anonymous, then with the session) and the
    // innertube clients; repeating the whole chain on an empty answer only doubled the
    // time to failure. retry once only when the ipc call itself errored out quickly
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      try {
        const raw = await invokeWithTimeout<unknown>(
          'get_stream_url',
          { videoId, fresh: fresh || null },
          STREAM_INVOKE_TIMEOUT_MS
        );
        const url = normalizeStreamUrl(raw);
        if (!url) console.warn('[stream] no playable url for', videoId);
        return url;
      } catch (err) {
        console.warn('[stream] invoke failed', videoId, 'attempt', attempt + 1, err);
        if (Date.now() - started > 5000) return null;
      }
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return null;
  })().finally(() => {
    inflightStreams.delete(videoId);
  });

  inflightStreams.set(videoId, task);
  return task;
}

/** radio / supermix / generated stations use an RD... id that is already a browse id */
export function isGeneratedMixId(id: string): boolean {
  return toPlainPlaylistId(id).startsWith('RD');
}

/** playlist browse ids are VL + the playlistId, like VLPL... / VLLM. RD mixes stay unprefixed. */
export function toPlaylistBrowseId(id: string): string {
  const raw = (id || '').trim();
  if (!raw) return raw;
  if (
    raw.startsWith('VL') ||
    raw.startsWith('FE') ||
    raw.startsWith('UC') ||
    raw.startsWith('MPRE') ||
    raw.startsWith('MPSP')
  ) {
    return raw;
  }
  // prefixing VL turns Energy Supermix / radio pages into a "empty playlist" miss
  if (raw.startsWith('RD')) return raw;
  if (/^(PL|OL|LM|UU)/.test(raw)) return `VL${raw}`;
  return raw;
}

/** ids to try when opening a playlist page; generated mixes prefer the raw RD id */
export function playlistBrowseCandidates(browseId: string): string[] {
  const raw = (browseId || '').trim();
  if (!raw) return [];
  if (isGeneratedMixId(raw)) {
    const plain = toPlainPlaylistId(raw);
    return Array.from(new Set([plain, raw].filter(Boolean)));
  }
  return Array.from(new Set([toPlaylistBrowseId(raw), raw].filter(Boolean)));
}

const EMPTY_PLAYLIST = Symbol('empty-playlist');

function findRenderer(node: any, key: string, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 24) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findRenderer(n, key, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (node[key]) return node[key];
  for (const v of Object.values(node)) {
    const hit = findRenderer(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * the part of a playlist/album page that holds its own items. a playlist page also
 * carries "suggestions" / "more like this" shelves (and an empty one is *only*
 * suggestions), so walking the whole response played unrelated songs for empty lists
 */
export function playlistContentRoot(data: any, browseId: string): any {
  const shelf = findRenderer(data, 'musicPlaylistShelfRenderer');
  if (shelf) return shelf;
  // generated mixes (Energy Supermix, radio, etc.) list tracks in a plain music shelf,
  // even when someone stored the id with a VL prefix
  if (browseId.startsWith('VL') && !isGeneratedMixId(browseId)) {
    // "episodes for later" (SE) lists its episodes in a plain music shelf; on a normal
    // playlist a plain shelf is the suggestions block, so no playlist shelf == empty
    if (browseId === 'VLSE') {
      const plain = findRenderer(data, 'musicShelfRenderer');
      if (plain) return plain;
    }
    return EMPTY_PLAYLIST;
  }
  // albums, radio and supermix pages: their tracks sit in a plain music shelf too
  return findRenderer(data, 'musicShelfRenderer') ?? data;
}

export type PlaylistLoad = { items: Track[]; status: 'ok' | 'empty' | 'failed' };

export async function getPlaylistItems(browseId: string, lang: Language): Promise<Track[]> {
  return (await loadPlaylistItems(browseId, lang)).items;
}

/** like getPlaylistItems but tells an empty playlist apart from a failed request */
export async function loadPlaylistItems(browseId: string, lang: Language): Promise<PlaylistLoad> {
  const ids = playlistBrowseCandidates(browseId);
  let sawEmpty = false;
  for (const id of ids) {
    try {
      const headers = await buildAuthHeaders(lang);
      const response = await fetchWithTimeout(ytmUrl('browse'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...buildClientContext(lang), browseId: id }),
      });
      if (!response.ok) continue;
      const data = JSON.parse(await response.text());
      if (data?.error || !data?.contents) continue;
      const root = playlistContentRoot(data, id);
      if (root === EMPTY_PLAYLIST) {
        sawEmpty = true;
        continue;
      }
      const tracks: Track[] = [];
      const seen = new Set<string>();
      const addFrom = (payload: unknown) => {
        for (const t of extractAllTracks(payload, translations[lang])) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        }
      };
      addFrom(root);
      let token = findContinuationToken(root);
      for (let round = 0; token && round < 50; round += 1) {
        const cont = await fetchPlaylistContinuation(token, lang);
        addFrom(cont.data);
        token = cont.next;
      }
      if (tracks.length) return { items: tracks, status: 'ok' };
      sawEmpty = true;
    } catch {
      /* nah that id sucked, next */
    }
  }
  return { items: [], status: sawEmpty ? 'empty' : 'failed' };
}

// library, you gotta be signed in
export type LibraryCategory =
  | 'landing'
  | 'playlists'
  | 'songs'
  | 'albums'
  | 'artists'
  | 'subscriptions'
  | 'history'
  | 'podcasts';

export const LIBRARY_BROWSE_IDS: Record<LibraryCategory, string> = {
  landing: 'FEmusic_library_landing',
  playlists: 'FEmusic_liked_playlists',
  songs: 'FEmusic_liked_videos',
  albums: 'FEmusic_liked_albums',
  artists: 'FEmusic_library_corpus_track_artists',
  subscriptions: 'FEmusic_library_corpus_artists',
  history: 'FEmusic_history',
  podcasts: 'FEmusic_library_non_music_audio_list',
};

const libraryContinuations = new Map<string, string | null>();
/** pages fetched before the first paint (each ~25 rows). more load in the background. */
const LIBRARY_INITIAL_PAGE_LIMIT = 2;
const LIBRARY_BACKGROUND_PAGE_LIMIT = 40;

const LIBRARY_CACHE_TTL_MS = 60_000;

function libraryCacheKey(category: LibraryCategory, lang: Language) {
  return `${category}:${lang}`;
}

/** library shelves come 25 at a time; `maxPages` caps sequential awaits so the UI can paint early */
async function appendLibraryPages(
  browseId: string,
  lang: Language,
  sections: Section[],
  maxPages: number = LIBRARY_INITIAL_PAGE_LIMIT
) {
  if (!sections.length) return sections;
  const key = [...libraryContinuations.keys()].find((k) => k.startsWith(`${browseId}:${lang}:`));
  let token = key ? libraryContinuations.get(key) : null;
  if (key) libraryContinuations.delete(key);
  const target = sections[sections.length - 1];
  const seen = new Set(target.items.map((i) => i.id));
  const t = translations[lang];
  for (let round = 0; token && round < maxPages; round += 1) {
    try {
      const cont = await fetchPlaylistContinuation(token, lang);
      for (const sec of parseShelves(cont.data, t)) {
        for (const item of sec.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            target.items.push(item);
          }
        }
      }
      token = cont.next && cont.next !== token ? cont.next : null;
    } catch {
      break;
    }
  }
  // stash leftover token so a background pass (or next open) can continue
  if (token) libraryContinuations.set(`${browseId}:${lang}:pending`, token);
  else libraryContinuations.delete(`${browseId}:${lang}:pending`);
  return sections;
}

/** keep pulling continuation pages into an already-shown library section list */
export async function extendLibrarySections(
  category: LibraryCategory,
  lang: Language,
  sections: Section[],
  maxPages: number = LIBRARY_BACKGROUND_PAGE_LIMIT
): Promise<Section[]> {
  if (!sections.length) return sections;
  const id = LIBRARY_BROWSE_IDS[category];
  const cloned = sections.map((s) => ({ ...s, items: s.items.slice() }));
  await appendLibraryPages(id, lang, cloned, maxPages);
  const cacheKey = libraryCacheKey(category, lang);
  librarySectionCache.set(cacheKey, { at: Date.now(), sections: cloned });
  return cloned;
}

export async function getLibrary(
  category: LibraryCategory,
  lang: Language,
  opts: { maxPages?: number; bypassCache?: boolean } = {}
): Promise<Section[]> {
  if (!(await isLoggedIn())) return [];
  const cacheKey = libraryCacheKey(category, lang);
  if (!opts.bypassCache) {
    const hit = librarySectionCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LIBRARY_CACHE_TTL_MS) {
      return hit.sections.map((sec) => ({ ...sec, items: applyPlaylistOverrides(sec.items) }));
    }
  }
  try {
    const id = LIBRARY_BROWSE_IDS[category];
    const maxPages = opts.maxPages ?? LIBRARY_INITIAL_PAGE_LIMIT;
    const sections = await appendLibraryPages(id, lang, await fetchBrowse(id, lang), maxPages);
    const mapped = sections.map((sec) => ({ ...sec, items: applyPlaylistOverrides(sec.items) }));
    librarySectionCache.set(cacheKey, { at: Date.now(), sections: mapped });
    return mapped;
  } catch {
    return [];
  }
}

export interface AccountProfile {
  name: string;
  email?: string;
  avatarUrl?: string;
}

function walkAccountProfile(node: unknown, depth = 0): AccountProfile | null {
  if (!node || depth > 14) return null;
  if (typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;

  const header = o.musicResponsiveHeaderRenderer as Record<string, unknown> | undefined;
  if (header?.title) {
    const runs = (header.title as { runs?: { text?: string }[] }).runs;
    const name = runs?.[0]?.text?.trim();
    if (name) {
      const thumbs = (
        header.thumbnail as {
          musicThumbnailRenderer?: { thumbnail?: { thumbnails?: { url?: string }[] } };
        }
      )?.musicThumbnailRenderer?.thumbnail?.thumbnails;
      const avatarUrl = thumbs?.[thumbs.length - 1]?.url;
      return { name, avatarUrl };
    }
  }

  const settings = o.accountSettingsPage as Record<string, unknown> | undefined;
  if (settings?.title) {
    const runs = (settings.title as { runs?: { text?: string }[] }).runs;
    const name = runs?.[0]?.text?.trim();
    if (name) return { name };
  }

  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = walkAccountProfile(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = walkAccountProfile(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** name + avatar from the ytm account menu */
export async function getAccountProfile(lang: Language): Promise<AccountProfile | null> {
  const headers = await buildAuthHeaders(lang);
  if (!headers.Authorization) return null;
  try {
    const response = await fetchWithTimeout(
      ytmUrl('account/account_menu'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(buildClientContext(lang)),
      },
      8000
    );
    if (!response.ok) return null;
    const data = JSON.parse(await response.text());
    if (data?.error) return null;
    return walkAccountProfile(data);
  } catch {
    return null;
  }
}

/** your playlists in the sidebar, also needs login */
export async function getUserPlaylists(lang: Language): Promise<Track[]> {
  if (!(await isLoggedIn())) return [];
  const [playlistSections, landingSections] = await Promise.all([
    getLibrary('playlists', lang),
    getLibrary('landing', lang),
  ]);
  const out: Track[] = [];
  const seen = new Set<string>();
  const pushPlaylist = (item: Track) => {
    if (item.type !== 'playlist' || seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  for (const section of [...playlistSections, ...landingSections]) {
    for (const item of section.items) pushPlaylist(item);
  }
  // liked music is often only on the landing browse, not the playlists tab
  if (!out.some((p) => p.title.toLowerCase().includes('liked'))) {
    for (const section of landingSections) {
      for (const item of section.items) {
        if (
          item.id.startsWith('VL') &&
          (item.title.toLowerCase().includes('liked') ||
            item.title.toLowerCase().includes('ulubione'))
        ) {
          pushPlaylist({ ...item, type: 'playlist' });
        }
      }
    }
  }
  return out;
}

export type PlaylistPrivacy = 'PRIVATE' | 'PUBLIC' | 'UNLISTED';

/** signed-in innertube write call; throws on missing login, HTTP errors and api errors */
export async function ytmAction(endpoint: string, body: Record<string, unknown>, lang: Language) {
  const headers = await buildAuthHeaders(lang);
  if (!headers.Authorization) throw new Error('not signed in');
  const response = await fetchWithTimeout(
    ytmUrl(endpoint),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildClientContext(lang), ...body }),
    },
    12000
  );
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`);
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${endpoint}: bad response`);
  }
  if (data?.error) throw new Error(`${endpoint}: ${data.error.message || 'api error'}`);
  // edit_playlist answers 200 with a status field even when it refused the change
  if (typeof data?.status === 'string' && data.status !== 'STATUS_SUCCEEDED') {
    throw new Error(`${endpoint}: ${data.status}`);
  }
  return data;
}

/** playlist ids show up as VLxxxx (browse id) or plain; the write apis want the plain one */
export function toPlainPlaylistId(id: string): string {
  return id.startsWith('VL') ? id.slice(2) : id;
}

/** liked music / watch later etc. are system lists that can't be renamed or deleted */
export function isEditablePlaylist(id: string): boolean {
  const plain = toPlainPlaylistId(id);
  return Boolean(plain) && !['LM', 'WL', 'SE', 'LL'].includes(plain) && !plain.startsWith('RD');
}

export async function createPlaylist(
  title: string,
  description: string,
  privacy: PlaylistPrivacy,
  lang: Language
): Promise<string | null> {
  const name = title.trim().slice(0, 150);
  if (!name) throw new Error('empty title');
  const data = await ytmAction(
    'playlist/create',
    { title: name, description: description.slice(0, 5000), privacyStatus: privacy },
    lang
  );
  invalidateLibraryCache();
  return data?.playlistId || null;
}

export async function renamePlaylist(id: string, title: string, lang: Language): Promise<void> {
  const name = title.trim().slice(0, 150);
  if (!name) throw new Error('empty title');
  if (!isEditablePlaylist(id)) throw new Error('playlist not editable');
  await ytmAction(
    'browse/edit_playlist',
    {
      playlistId: toPlainPlaylistId(id),
      actions: [{ action: 'ACTION_SET_PLAYLIST_NAME', playlistName: name }],
    },
    lang
  );
  rememberPlaylistRenamed(id, name);
  invalidateLibraryCache();
}

export async function deletePlaylist(id: string, lang: Language): Promise<void> {
  if (!isEditablePlaylist(id)) throw new Error('playlist not editable');
  await ytmAction('playlist/delete', { playlistId: toPlainPlaylistId(id) }, lang);
  rememberPlaylistDeleted(id);
  invalidateLibraryCache();
}

/** thrown by addToPlaylist when the track is already there (and no duplicate was asked for) */
export class AlreadyInPlaylistError extends Error {
  constructor() {
    super('already in playlist');
    this.name = 'AlreadyInPlaylistError';
  }
}

export async function addToPlaylist(
  playlistId: string,
  videoId: string,
  lang: Language,
  opts: { allowDuplicate?: boolean } = {}
): Promise<void> {
  if (!isYoutubeVideoId(videoId)) throw new Error('not a track');
  if (!opts.allowDuplicate) {
    // DEDUPE_OPTION_SKIP alone is not honoured any more (the api answers SUCCEEDED and
    // appends a second copy), so look at the playlist first. if that read fails we
    // still add rather than block the user
    const current = await loadPlaylistItems(
      toPlaylistBrowseId(toPlainPlaylistId(playlistId)),
      lang
    );
    if (current.items.some((t) => t.id === videoId)) throw new AlreadyInPlaylistError();
  }
  const action: Record<string, unknown> = { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId };
  if (!opts.allowDuplicate) action.dedupeOption = 'DEDUPE_OPTION_SKIP';
  await ytmAction(
    'browse/edit_playlist',
    { playlistId: toPlainPlaylistId(playlistId), actions: [action] },
    lang
  );
  invalidateLibraryCache();
}

export type TrackLikeStatus = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

export function likeEndpointFor(status: TrackLikeStatus): string {
  if (status === 'LIKE') return 'like/like';
  if (status === 'DISLIKE') return 'like/dislike';
  return 'like/removelike';
}

/** click a thumb again to clear it; the other thumb replaces the current rating */
export function nextLikeStatus(
  current: TrackLikeStatus,
  action: 'like' | 'dislike'
): TrackLikeStatus {
  if (action === 'like') return current === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
  return current === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';
}

/** thumbs-up / thumbs-down / clear on youtube music (feeds Liked Music) */
export async function setTrackRating(
  videoId: string,
  status: TrackLikeStatus,
  lang: Language
): Promise<void> {
  if (!isYoutubeVideoId(videoId)) throw new Error('not a track');
  await ytmAction(likeEndpointFor(status), { target: { videoId } }, lang);
  invalidateLibraryCache();
}

/** thumbs-up / remove like on youtube music (feeds the Liked Music playlist) */
export async function setTrackLiked(
  videoId: string,
  liked: boolean,
  lang: Language
): Promise<void> {
  await setTrackRating(videoId, liked ? 'LIKE' : 'INDIFFERENT', lang);
}

// related tab, playlists / similar artists / the about blurb
export interface RelatedResult {
  sections: Section[];
  about: string | null;
}

function findRelatedBrowseId(data: any): string | null {
  let found: string | null = null;
  const walk = (node: any) => {
    if (!node || found) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    const id = node.tabRenderer?.endpoint?.browseEndpoint?.browseId;
    if (typeof id === 'string' && id.startsWith('MPTRt')) {
      found = id;
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return found;
}

function extractAboutText(data: any): string | null {
  let about: string | null = null;
  const walk = (node: any) => {
    if (!node || about) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    const shelf = node.musicDescriptionShelfRenderer;
    if (shelf?.description) {
      const text = extractFirstText(shelf.description);
      if (text) {
        about = text;
        return;
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return about;
}

export async function getWatchRelated(videoId: string, lang: Language): Promise<RelatedResult> {
  try {
    const headers = await buildAuthHeaders(lang);
    const nextRes = await fetch(ytmUrl('next'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildClientContext(lang), videoId }),
    });
    if (!nextRes.ok) return { sections: [], about: null };
    const nextData = JSON.parse(await nextRes.text());
    const browseId = findRelatedBrowseId(nextData);
    if (!browseId) return { sections: [], about: null };
    const relRes = await fetch(ytmUrl('browse'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildClientContext(lang), browseId }),
    });
    if (!relRes.ok) return { sections: [], about: null };
    const relData = JSON.parse(await relRes.text());
    return {
      sections: parseShelves(relData, translations[lang]),
      about: extractAboutText(relData),
    };
  } catch {
    return { sections: [], about: null };
  }
}

export async function getRelatedTracks(
  query: string,
  lang: Language,
  excludeId?: string
): Promise<Track[]> {
  const sections = await searchMusic(query, lang);
  return sections
    .flatMap((s) => s.items)
    .filter((i) => i.type === 'track')
    .filter((i) => (excludeId ? i.id !== excludeId : true))
    .slice(0, 14);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** musixmatch often needs a token + signed secret fetch before lyrics land */
const LYRICS_TIMEOUT_MS: Partial<Record<LyricsProvider, number>> = {
  Musixmatch: 22000,
  LyricsGenius: 15000,
  'YouTube Music': 12000,
  LRCLib: 10000,
  'Lyrics.ovh': 8000,
};
const DEFAULT_LYRICS_TIMEOUT_MS = 12000;

function lyricsTimeoutFor(provider: LyricsProvider): number {
  return LYRICS_TIMEOUT_MS[provider] ?? DEFAULT_LYRICS_TIMEOUT_MS;
}

// cache hits so opening player again is instant
// failures get a short ttl so we can retry later
const lyricsCache = new Map<string, { data: LyricsResult; ts: number; ok: boolean }>();
const LYRICS_CACHE_LIMIT = 20;
const LYRICS_OK_TTL = 20 * 60 * 1000;
const LYRICS_FAIL_TTL = 2 * 60 * 1000;

type Attempt = { res: LyricsResult | null; failure: LyricsFailure | null };

/** results of every promise that settles, but once one is `good`, only waits `graceMs`
 * longer for the rest; the late ones are left out */
function settleWithGrace(
  tasks: Promise<Attempt>[],
  good: (x: Attempt) => boolean,
  graceMs: number,
  early?: Promise<void>
): Promise<Attempt[]> {
  return new Promise((resolve) => {
    const done: (Attempt | undefined)[] = tasks.map(() => undefined);
    let left = tasks.length;
    let timer: number | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      resolve(done.filter((x): x is Attempt => x !== undefined));
    };
    early?.then(finish);
    tasks.forEach((t, i) => {
      t.then((x) => {
        done[i] = x;
        left -= 1;
        if (left === 0) finish();
        else if (good(x) && timer === undefined) timer = window.setTimeout(finish, graceMs);
      });
    });
  });
}

export async function getLyrics(
  track: Track,
  lang: Language,
  preferred?: LyricsProvider,
  onPlain?: (plain: LyricsResult) => void
): Promise<LyricsResult | null> {
  let smart = '1';
  try {
    smart = localStorage.getItem('zenith_smart_lyrics') === '0' ? '0' : '1';
  } catch {}
  const cacheKey = `${track.id}:${preferred || 'Auto'}:${lang}:${smart}`;
  const cached = lyricsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < (cached.ok ? LYRICS_OK_TTL : LYRICS_FAIL_TTL)) {
    return cached.data;
  }
  const result = await getLyricsUncached(track, lang, preferred, onPlain);
  if (result) {
    const ok = Boolean(result.synced?.length || result.text);
    lyricsCache.set(cacheKey, { data: result, ts: Date.now(), ok });
    pruneOldest(lyricsCache, LYRICS_CACHE_LIMIT);
  }
  return result;
}

async function getLyricsUncached(
  track: Track,
  lang: Language,
  preferred?: LyricsProvider,
  onPlain?: (plain: LyricsResult) => void
): Promise<LyricsResult | null> {
  const explicit = Boolean(preferred && preferred !== 'Auto');
  let allowPlain = explicit;
  let plainShown = false;
  const maybePlain = (res: LyricsResult) => {
    if (!allowPlain || plainShown) return;
    if (!shouldShowEarlyPlain(res)) return;
    plainShown = true;
    onPlain?.(res);
  };
  const attempt = async (
    p: LyricsProvider
  ): Promise<{ res: LyricsResult | null; failure: LyricsFailure | null }> => {
    try {
      const res = await withTimeout(getLyricsForProvider(track, lang, p), lyricsTimeoutFor(p), p);
      if (res && (res.synced?.length || res.text)) {
        // Lyrics.ovh has no title/artist metadata, so Auto must not display it
        if (p === 'Lyrics.ovh' && !explicit) {
          return {
            res: null,
            failure: {
              provider: p,
              reason: 'Lyrics.ovh result skipped until a title/artist match can be verified',
            },
          };
        }
        maybePlain(res);
        return { res, failure: null };
      }
      return { res: null, failure: { provider: p, reason: 'No lyrics found for this track' } };
    } catch (e) {
      return { res: null, failure: { provider: p, reason: errorMessage(e) } };
    }
  };

  if (explicit) {
    const { res, failure } = await attempt(preferred!);
    if (res) return res;
    return { provider: preferred!, text: null, failures: failure ? [failure] : [] };
  }

  const failures: LyricsFailure[] = [];
  let plainFallback: LyricsResult | null = null;

  // fallbacks run in parallel with synced sources but cannot paint until those settle,
  // so a fast Lyrics.ovh / stale Genius hit cannot flash the wrong song
  const fallbackOrder: LyricsProvider[] = ['YouTube Music', 'LyricsGenius'];
  const fallbacks = fallbackOrder.map((p) => attempt(p));
  const raced = await settleWithGrace(
    [attempt('LRCLib'), attempt('Musixmatch')],
    (x) => Boolean(x.res?.synced?.length),
    1500
  );
  const syncedHits = raced
    .map((x) => x.res)
    .filter((r): r is LyricsResult => Boolean(r?.synced?.length));
  for (const x of raced) if (x.failure) failures.push(x.failure);
  if (syncedHits.length) {
    return pickBestSyncedLyrics(syncedHits);
  }
  for (const x of raced) {
    if (x.res?.text && !plainFallback) plainFallback = x.res;
  }

  allowPlain = true;
  if (plainFallback) maybePlain(plainFallback);

  for (const pending of fallbacks) {
    const { res, failure } = await pending;
    if (failure) failures.push(failure);
    if (res?.synced?.length) return res;
    if (res?.text && !plainFallback) {
      plainFallback = res;
      maybePlain(res);
    }
  }

  if (plainFallback) return plainFallback;
  return { provider: 'Auto', text: null, failures };
}

type TranslationBundle = (typeof translations)[Language];

function extractFirstText(node: any): string | null {
  if (!node) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = extractFirstText(item);
      if (text) return text;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  if (typeof node.simpleText === 'string' && node.simpleText.trim()) return node.simpleText.trim();
  if (typeof node.text === 'string' && node.text.trim()) return node.text.trim();
  if (Array.isArray(node.runs)) {
    const joined = node.runs
      .map((run: any) => run?.text || '')
      .join('')
      .trim();
    if (joined) return joined;
  }

  for (const value of Object.values(node)) {
    const text = extractFirstText(value);
    if (text) return text;
  }

  return null;
}

function parseTimestamp(min: string, sec: string, frac?: string): number {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + f;
}

function parseLrc(text: string): LyricsLine[] {
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

function parseRichsync(text: string): LyricsLine[] {
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

function parseMxmSubtitles(text: string): LyricsLine[] {
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

function parseMusixmatchSynced(body: string): LyricsLine[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('[') && trimmed.includes('{')) {
    const rich = parseRichsync(trimmed);
    if (rich.length) return rich;
    const mxm = parseMxmSubtitles(trimmed);
    if (mxm.length) return mxm;
  }
  return parseLrc(body);
}

function parseVtt(text: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const m = block.match(/(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->/);
    if (!m) continue;
    const hours = m[1] ? Number(m[1]) : 0;
    const time = hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const payload = block
      .split('\n')
      .filter((l) => l && !l.includes('-->') && l !== 'WEBVTT' && !/^\d+$/.test(l.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (!payload || /^[♪♫*\-_.\s]+$/.test(payload)) continue;
    lines.push({ time, text: payload });
  }
  return normalizeSynced(mergeCaptionPhrases(lines));
}

/** youtube auto captions dump a cue per word, glue them into actual lines */
function mergeCaptionPhrases(lines: LyricsLine[]): LyricsLine[] {
  if (lines.length < 10) return lines;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) gaps.push(lines[i].time - lines[i - 1].time);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 2;
  if (median > 1.05) return lines;
  const out: LyricsLine[] = [];
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nextGap = i + 1 < lines.length ? lines[i + 1].time - line.time : 99;
    if (!buf) start = line.time;
    buf = buf ? `${buf} ${line.text}` : line.text;
    const long = buf.length >= 42 || buf.split(' ').length >= 8;
    if (nextGap > 1.2 || long) {
      out.push({ time: start, text: buf.replace(/\s+/g, ' ').trim() });
      buf = '';
    }
  }
  if (buf.trim()) out.push({ time: start, text: buf.replace(/\s+/g, ' ').trim() });
  return out.length >= 4 ? out : lines;
}

function normalizeSynced(lines: LyricsLine[]): LyricsLine[] {
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

function queryDuration(track: Track): number | undefined {
  const d = track.durationSec;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
}

function scoreMatch(
  title: string,
  artist: string,
  candidateTitle: string,
  candidateArtist: string,
  durationSec?: number | null,
  candidateDuration?: number | null
): number {
  return scoreLyricsMatch(
    { title, artist, durationSec },
    { title: candidateTitle, artist: candidateArtist, durationSec: candidateDuration }
  );
}

function acceptMatch(
  title: string,
  artist: string,
  candidateTitle: string,
  candidateArtist: string,
  score: number,
  durationSec?: number | null,
  candidateDuration?: number | null
): boolean {
  return isAcceptableLyricsMatch(
    { title, artist, durationSec },
    { title: candidateTitle, artist: candidateArtist, durationSec: candidateDuration },
    score
  );
}

/** browser-like headers; a bare GET to timedtext is often 403 without a watch Referer */
export function youtubeTimedtextHeaders(videoId: string): Record<string, string> {
  return {
    Accept: 'text/vtt, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
    'User-Agent': LYRICS_BROWSER_UA,
    Referer: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    Origin: 'https://www.youtube.com',
  };
}

export function withVttFmt(url: string): string {
  if (/[?&]fmt=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}fmt=vtt`;
}

/** caption baseUrls buried in a player / next payload */
export function captionTrackUrlsFromPlayer(data: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.startsWith('http')) return;
    if (!/timedtext|caption/i.test(raw) && !/[?&](?:kind|lang|fmt|v)=/.test(raw)) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    urls.push(raw);
  };
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 12 || urls.length >= 16) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    add(rec.baseUrl);
    if (Array.isArray(rec.captionTracks)) {
      for (const track of rec.captionTracks) {
        if (track && typeof track === 'object') add((track as { baseUrl?: unknown }).baseUrl);
      }
    }
    for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  walk(data, 0);
  return urls;
}

async function fetchTimedtextVtt(url: string, videoId: string): Promise<LyricsLine[] | null> {
  const headers = youtubeTimedtextHeaders(videoId);
  try {
    const cookie = await getYtmCookie();
    if (cookie) headers.Cookie = cookie;
  } catch {
    /* guest timedtext still works with Referer + UA */
  }
  const response = await fetch(withVttFmt(url), { method: 'GET', headers });
  if (!response.ok) return null;
  const raw = await response.text();
  if (!raw || raw.length < 20 || !raw.includes('-->')) return null;
  const synced = parseVtt(raw);
  return synced.length >= 4 ? synced : null;
}

async function getYoutubeTimedtext(videoId: string, lang: Language): Promise<LyricsLine[] | null> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const langs = lang === 'pl' ? ['pl', 'en', 'en-US', 'en-GB'] : ['en', 'en-US', 'en-GB', 'pl'];
  const kinds = ['', '&kind=asr'];
  for (const trackLang of langs) {
    for (const kind of kinds) {
      try {
        const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&fmt=vtt&lang=${trackLang}${kind}`;
        const synced = await fetchTimedtextVtt(url, videoId);
        if (synced) return synced;
      } catch {
        /* next one */
      }
    }
  }
  return null;
}

async function getYouTubeMusicLyrics(track: Track, lang: Language): Promise<LyricsResult | null> {
  const timed = await getYoutubeTimedtext(track.id, lang);
  if (timed?.length) return { provider: 'YouTube Music', text: null, synced: timed, matchScore: 3 };

  const headers = await buildAuthHeaders(lang);
  const response = await fetch(ytmUrl('next'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...buildClientContext(lang), videoId: track.id }),
  });
  if (!response.ok) throw new Error(`YouTube Music HTTP ${response.status}`);
  const data = JSON.parse(await response.text());
  for (const captionUrl of captionTrackUrlsFromPlayer(data)) {
    try {
      const fromPlayer = await fetchTimedtextVtt(captionUrl, track.id);
      if (fromPlayer?.length) {
        return { provider: 'YouTube Music', text: null, synced: fromPlayer, matchScore: 3 };
      }
    } catch {
      /* try the lyrics tab next */
    }
  }
  const browseId = findLyricsBrowseId(data, lang);
  if (!browseId) throw new Error('This video has no Lyrics tab on YouTube Music');
  const lyricsResponse = await fetch(ytmUrl('browse'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...buildClientContext(lang), browseId }),
  });
  if (!lyricsResponse.ok) throw new Error(`YouTube Music lyrics HTTP ${lyricsResponse.status}`);
  const lyricsData = JSON.parse(await lyricsResponse.text());
  const lyricsText = extractLyricsText(lyricsData);
  if (!lyricsText) throw new Error('Lyrics tab exists but returned no text (possibly region-restricted)');
  return { provider: 'YouTube Music', text: lyricsText };
}

async function getLrclibLyrics(track: Track): Promise<LyricsResult | null> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const attempts = [
    `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
    `q=${encodeURIComponent(`${title} ${artist}`)}`,
    `track_name=${encodeURIComponent(title)}`,
  ];
  let lastErr: Error | null = null;
  let bestPlain: LyricsResult | null = null;
  let bestPlainScore = 0;

  for (const qs of attempts) {
    try {
      const url = `https://lrclib.net/api/search?${qs}`;
      const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`LRCLib HTTP ${response.status}`);
      const data = JSON.parse(await response.text());
      if (!Array.isArray(data) || data.length === 0) {
        lastErr = new Error('No entry in the LRCLib database for this title/artist');
        continue;
      }

      let best: { score: number; synced?: LyricsLine[]; plain?: string } | null = null;
      for (const item of data) {
        if (item?.instrumental) continue;
        const candTitle = String(item?.trackName || item?.name || '');
        const candArtist = String(item?.artistName || item?.artist || '');
        const candDuration = Number(item?.duration);
        const durationSec =
          Number.isFinite(candDuration) && candDuration > 0 ? candDuration : undefined;
        const score = scoreMatch(
          title,
          artist,
          candTitle,
          candArtist,
          queryDuration(track),
          durationSec
        );
        if (
          !acceptMatch(
            title,
            artist,
            candTitle,
            candArtist,
            score,
            queryDuration(track),
            durationSec
          )
        ) {
          continue;
        }
        if (item?.syncedLyrics) {
          const synced = parseLrc(String(item.syncedLyrics));
          if (
            synced.length >= 2 &&
            (!best ||
              score > best.score ||
              (score === best.score && synced.length > (best.synced?.length || 0)))
          ) {
            best = { score, synced };
          }
        } else if (item?.plainLyrics && score > bestPlainScore) {
          bestPlainScore = score;
          bestPlain = { provider: 'LRCLib', text: String(item.plainLyrics), matchScore: score };
        }
      }
      if (best?.synced?.length) {
        return { provider: 'LRCLib', text: null, synced: best.synced, matchScore: best.score };
      }
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (bestPlain) return bestPlain;
  throw lastErr || new Error('LRCLib failed');
}

async function getLyricsOvh(track: Track): Promise<LyricsResult | null> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (response.status === 404) throw new Error('Not in the Lyrics.ovh database');
  if (!response.ok) throw new Error(`Lyrics.ovh HTTP ${response.status}`);
  const data = JSON.parse(await response.text());
  if (data?.lyrics) return { provider: 'Lyrics.ovh', text: String(data.lyrics) };
  throw new Error(data?.error ? `Lyrics.ovh: ${data.error}` : 'Empty response from Lyrics.ovh');
}

// musixmatch community api (that strvm musicxmatch thing)
// dziala jak chce, jak nie to lrclib, nie pytać
const MXM_WS_BASE = 'https://www.musixmatch.com/ws/1.1/';
const MXM_APP_ID = 'mxm-com-v1.0';
const MXM_FALSE_POSITIVE_TRACK_ID = 115264642;
const MXM_SECRET_TTL = 6 * 60 * 60 * 1000;
let mxmSecretCache: { secret: string; ts: number } | null = null;

async function fetchMusixmatchSecret(): Promise<string> {
  if (mxmSecretCache && Date.now() - mxmSecretCache.ts < MXM_SECRET_TTL)
    return mxmSecretCache.secret;

  let bundleUrls: string[] = [];
  const pageRes = await fetch('https://www.musixmatch.com/search', {
    method: 'GET',
    headers: MXM_COMMUNITY_HEADERS,
  });
  if (pageRes.ok) {
    bundleUrls = collectMusixmatchBundleUrls(await pageRes.text());
  }

  let lastErr: Error | null = null;
  // the signing secret lives in a hashed chunk now, not pages/_app, so search more of them
  const candidates = bundleUrls.slice(0, 30);
  const batchSize = 6;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (src) => {
        try {
          const jsRes = await fetch(src, {
            method: 'GET',
            headers: { 'User-Agent': LYRICS_BROWSER_UA },
          });
          if (!jsRes.ok) return null;
          return extractMusixmatchSecretFromJs(await jsRes.text());
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          return null;
        }
      })
    );
    for (const secret of results) {
      if (!secret) continue;
      mxmSecretCache = { secret, ts: Date.now() };
      return secret;
    }
  }
  throw lastErr || new Error(MXM_SECRET_MISSING);
}

async function signMusixmatchUrl(url: string): Promise<string> {
  const secret = await fetchMusixmatchSecret();
  const now = new Date();
  const dateStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(url + dateStr));
  const bytes = new Uint8Array(sigBuf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `${url}&signature=${encodeURIComponent(btoa(bin))}&signature_protocol=sha256`;
}

async function musixmatchRequest(endpoint: string): Promise<any> {
  const url = (MXM_WS_BASE + endpoint).replace(/%20/g, '+').replace(/ /g, '+');
  const signed = await signMusixmatchUrl(url);
  const res = await fetch(signed, {
    method: 'GET',
    headers: MXM_COMMUNITY_HEADERS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  const code = json?.message?.header?.status_code;
  if (code !== 200) {
    const hint = json?.message?.header?.hint;
    throw new Error(`API status ${code}${hint ? ` (${hint})` : ''}`);
  }
  return json;
}

function catalogDuration(
  trackLike: { track_length?: number } | null | undefined
): number | undefined {
  const candDuration = Number(trackLike?.track_length);
  return Number.isFinite(candDuration) && candDuration > 0 ? candDuration : undefined;
}

function pickMusixmatchCatalogTrack(
  list: any[],
  title: string,
  artist: string,
  duration?: number
): { track: any; score: number } | null {
  let best: any = null;
  let bestScore = -1;
  for (const item of list) {
    const cand = item?.track ?? item;
    if (!cand || cand.track_id === MXM_FALSE_POSITIVE_TRACK_ID) continue;
    const durationSec = catalogDuration(cand);
    const score = scoreMatch(
      title,
      artist,
      cand.track_name || '',
      cand.artist_name || '',
      duration,
      durationSec
    );
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (
    !best ||
    !acceptMatch(
      title,
      artist,
      best.track_name || '',
      best.artist_name || '',
      bestScore,
      duration,
      catalogDuration(best)
    )
  ) {
    return null;
  }
  return { track: best, score: bestScore };
}

async function searchMusixmatchCatalog(title: string, artist: string): Promise<any[]> {
  const qTrack = encodeURIComponent(title);
  const qArtist = encodeURIComponent(artist);
  const q = encodeURIComponent(`${title} ${artist}`);
  const endpoints = [
    `track.search?app_id=${MXM_APP_ID}&format=json&q_track=${qTrack}&q_artist=${qArtist}&f_has_lyrics=true&page_size=10&page=1`,
    `track.search?app_id=${MXM_APP_ID}&format=json&q=${q}&f_has_lyrics=true&page_size=10&page=1`,
  ];
  let list: any[] = [];
  let lastError: Error | null = null;
  for (const endpoint of endpoints) {
    try {
      const searchJson = await musixmatchRequest(endpoint);
      list = searchJson?.message?.body?.track_list || [];
      if (list.length) return list;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (lastError && !list.length) throw lastError;
  return list;
}

async function lyricsFromMusixmatchCatalog(best: any, bestScore: number): Promise<LyricsResult> {
  if (best.has_richsync && (best.track_id || best.commontrack_id)) {
    try {
      const idParam = best.track_id
        ? `track_id=${best.track_id}`
        : `commontrack_id=${best.commontrack_id}`;
      const rsJson = await musixmatchRequest(
        `track.richsync.get?app_id=${MXM_APP_ID}&format=json&${idParam}`
      );
      const body = rsJson?.message?.body?.richsync?.richsync_body;
      if (body) {
        const synced = parseMusixmatchSynced(String(body));
        if (synced.length > 0) {
          return { provider: 'Musixmatch', text: null, synced, matchScore: bestScore };
        }
      }
    } catch {
      // synced lyrics are often locked; plain text below still works
    }
  }

  if (best.has_subtitles && best.commontrack_id) {
    try {
      const subJson = await musixmatchRequest(
        `track.subtitle.get?app_id=${MXM_APP_ID}&format=json&commontrack_id=${best.commontrack_id}&subtitle_format=lrc`
      );
      const body = subJson?.message?.body?.subtitle?.subtitle_body;
      if (body) {
        const synced = parseMusixmatchSynced(String(body));
        if (synced.length > 0) {
          return { provider: 'Musixmatch', text: null, synced, matchScore: bestScore };
        }
      }
    } catch {
      // no synced, just take the plain text below
    }
  }

  const lyrJson = await musixmatchRequest(
    `track.lyrics.get?app_id=${MXM_APP_ID}&format=json&track_id=${best.track_id}`
  );
  const body = lyrJson?.message?.body?.lyrics?.lyrics_body;
  if (body) return { provider: 'Musixmatch', text: String(body), matchScore: bestScore };
  throw new Error(
    `Matched "${best.track_name}" but Musixmatch returned no lyrics body (restricted?)`
  );
}

async function getMusixmatchLyricsSigned(track: Track): Promise<LyricsResult> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const list = await searchMusixmatchCatalog(title, artist);
  if (!list.length) throw new Error('No matching track in the Musixmatch catalog');
  const picked = pickMusixmatchCatalogTrack(list, title, artist, queryDuration(track));
  if (!picked) throw new Error('No matching track in the Musixmatch catalog');
  return lyricsFromMusixmatchCatalog(picked.track, picked.score);
}

// musixmatch desktop, token refresh the pear-desktop way
const MXM_DESKTOP_BASE = 'https://apic-desktop.musixmatch.com/ws/1.1/';
const MXM_DESKTOP_APP_ID = 'web-desktop-app-v1.0';
const MXM_TOKEN_KEY = 'zenith_mxm_usertoken';
const MXM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

let mxmCookie = 'x-mxm-user-id=';
let mxmToken: string | null = null;
let mxmTokenInflight: Promise<string> | null = null;

function mxmApplySetCookie(res: Response) {
  const raw = res.headers.get('set-cookie');
  if (raw) mxmCookie = raw.split(';')[0] || raw;
}

async function mxmDesktopFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    method: init.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': LYRICS_BROWSER_UA,
      Authority: 'apic-desktop.musixmatch.com',
      Cookie: mxmCookie,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  mxmApplySetCookie(res);
  return res;
}

function mxmInvalidateToken() {
  mxmToken = null;
  mxmTokenInflight = null;
  try {
    localStorage.removeItem(MXM_TOKEN_KEY);
  } catch {}
}

async function mxmEnsureToken(force = false): Promise<string> {
  if (!force) {
    if (mxmToken) return mxmToken;
    try {
      const stored = JSON.parse(localStorage.getItem(MXM_TOKEN_KEY) || 'null');
      if (
        stored?.token &&
        stored.expires > Date.now() &&
        !String(stored.token).includes('UpgradeOnly') &&
        !/^0+$/.test(String(stored.token))
      ) {
        mxmToken = String(stored.token);
        return stored.token as string;
      }
    } catch {}
  }
  mxmInvalidateToken();
  if (!mxmTokenInflight) {
    mxmTokenInflight = (async () => {
      try {
        const params = new URLSearchParams({
          app_id: MXM_DESKTOP_APP_ID,
          t: Math.random().toString(36).slice(2, 10),
        });
        const res = await mxmDesktopFetch(`${MXM_DESKTOP_BASE}token.get?${params}`);
        if (!res.ok) throw new Error(`token.get HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        const token = json?.message?.body?.user_token;
        if (!token || String(token).includes('UpgradeOnly') || /^0+$/.test(String(token))) {
          const hint = json?.message?.header?.hint;
          throw new Error(`token.get failed${hint ? ` (${hint})` : ' (restricted token)'}`);
        }
        mxmToken = String(token);
        try {
          localStorage.setItem(
            MXM_TOKEN_KEY,
            JSON.stringify({ token: mxmToken, expires: Date.now() + MXM_TOKEN_TTL_MS })
          );
        } catch {}
        return mxmToken;
      } finally {
        mxmTokenInflight = null;
      }
    })();
  }
  const token = await mxmTokenInflight;
  if (!token) throw new Error('Failed to get Musixmatch token');
  return token;
}

async function mxmDesktopQuery(
  endpoint: string,
  params: Record<string, string>,
  retried = false
): Promise<{ header: { status_code: number }; body: any }> {
  const token = await mxmEnsureToken(retried);
  const qs = new URLSearchParams({
    app_id: MXM_DESKTOP_APP_ID,
    format: 'json',
    usertoken: token,
    ...params,
  });
  const res = await mxmDesktopFetch(`${MXM_DESKTOP_BASE}${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  const status = json?.message?.header?.status_code;
  if (status === 401 && !retried) {
    mxmInvalidateToken();
    return mxmDesktopQuery(endpoint, params, true);
  }
  if (status && status !== 200) {
    const hint = json?.message?.header?.hint;
    throw new Error(`API status ${status}${hint ? ` (${hint})` : ''}`);
  }
  return json.message;
}

function lyricsFromDesktopMacro(
  macro: any,
  title: string,
  artist: string,
  duration?: number
): LyricsResult | Error | null {
  const trackInfo = macro['matcher.track.get']?.message?.body?.track;
  const lyrics = macro['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
  const subtitle = macro['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle;
  const richsync = macro['track.richsync.get']?.message?.body?.richsync?.richsync_body;

  if (!trackInfo || trackInfo.track_id === MXM_FALSE_POSITIVE_TRACK_ID) return null;
  const candTitle = String(trackInfo.track_name || '');
  const candArtist = String(trackInfo.artist_name || '');
  const durationSec = catalogDuration(trackInfo);
  const score = scoreMatch(title, artist, candTitle, candArtist, duration, durationSec);
  if (!acceptMatch(title, artist, candTitle, candArtist, score, duration, durationSec)) {
    return new Error(`Musixmatch matched "${trackInfo.track_name}" which is the wrong song`);
  }

  if (richsync) {
    const synced = parseMusixmatchSynced(String(richsync));
    if (synced.length > 0) {
      return { provider: 'Musixmatch', text: null, synced, matchScore: score };
    }
  }
  if (subtitle?.subtitle_body) {
    const synced = parseMusixmatchSynced(String(subtitle.subtitle_body));
    if (synced.length > 0) {
      return { provider: 'Musixmatch', text: null, synced, matchScore: score };
    }
  }
  if (lyrics) return { provider: 'Musixmatch', text: String(lyrics), matchScore: score };
  return new Error(`Matched "${trackInfo.track_name}" but no lyrics returned (restricted?)`);
}

async function lyricsFromDesktopTrack(best: any, score: number): Promise<LyricsResult> {
  if (best.has_richsync && best.track_id) {
    try {
      const rs = await mxmDesktopQuery('track.richsync.get', { track_id: String(best.track_id) });
      const body = rs?.body?.richsync?.richsync_body;
      if (body) {
        const synced = parseMusixmatchSynced(String(body));
        if (synced.length > 0) {
          return { provider: 'Musixmatch', text: null, synced, matchScore: score };
        }
      }
    } catch {
      /* try subtitles next */
    }
  }
  if (best.has_subtitles && best.commontrack_id) {
    try {
      const sub = await mxmDesktopQuery('track.subtitle.get', {
        commontrack_id: String(best.commontrack_id),
        subtitle_format: 'lrc',
      });
      const body = sub?.body?.subtitle?.subtitle_body;
      if (body) {
        const synced = parseMusixmatchSynced(String(body));
        if (synced.length > 0) {
          return { provider: 'Musixmatch', text: null, synced, matchScore: score };
        }
      }
    } catch {
      /* try plain text next */
    }
  }
  const lyr = await mxmDesktopQuery('track.lyrics.get', { track_id: String(best.track_id) });
  const body = lyr?.body?.lyrics?.lyrics_body;
  if (body) return { provider: 'Musixmatch', text: String(body), matchScore: score };
  throw new Error(`Matched "${best.track_name}" but no lyrics returned (restricted?)`);
}

async function searchMusixmatchDesktopCatalog(
  title: string,
  artist: string,
  duration?: number
): Promise<{ track: any; score: number } | null> {
  const attempts: Record<string, string>[] = [
    { q_track: title, q_artist: artist, f_has_lyrics: '1', page_size: '10', page: '1' },
    { q: `${title} ${artist}`, f_has_lyrics: '1', page_size: '10', page: '1' },
  ];
  for (const params of attempts) {
    try {
      const msg = await mxmDesktopQuery('track.search', params);
      const list = msg?.body?.track_list || [];
      const picked = pickMusixmatchCatalogTrack(list, title, artist, duration);
      if (picked) return picked;
    } catch {
      /* try the next query shape */
    }
  }
  return null;
}

async function getMusixmatchLyricsDesktop(track: Track): Promise<LyricsResult> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const duration = queryDuration(track);
  const durationParams: Record<string, string> = {};
  if (duration) {
    const rounded = String(Math.round(duration));
    durationParams.q_duration = rounded;
    durationParams.f_subtitle_length = rounded;
    durationParams.f_subtitle_length_max_deviation = '5';
  }
  const queries: Record<string, string>[] = [
    { q_track: title, q_artist: artist, ...durationParams },
    { q_track: title, q_artist: artist.split(/[,&]/)[0]?.trim() || artist, ...durationParams },
  ];

  let lastError: Error | null = null;
  for (const q of queries) {
    try {
      const msg = await mxmDesktopQuery('macro.subtitles.get', {
        ...q,
        namespace: 'lyrics_richsynched',
        subtitle_format: 'lrc',
        optional_calls: 'track.richsync',
      });
      const macro = msg?.body?.macro_calls;
      if (!macro) continue;
      const result = lyricsFromDesktopMacro(macro, title, artist, duration);
      if (result && !(result instanceof Error)) return result;
      if (result instanceof Error) lastError = result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  const searched = await searchMusixmatchDesktopCatalog(title, artist, duration);
  if (searched) return lyricsFromDesktopTrack(searched.track, searched.score);

  throw lastError || new Error('No matching track in the Musixmatch catalog');
}

async function getMusixmatchLyricsSignedWithRetry(
  track: Track,
  attempts = 3
): Promise<LyricsResult> {
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getMusixmatchLyricsSigned(track);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const msg = lastError.message;
      if (!msg.includes('503') && !msg.includes('502') && !msg.includes('429')) throw lastError;
      if (i < attempts - 1) {
        mxmSecretCache = null;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }
  throw lastError || new Error('Community API unavailable');
}

async function getMusixmatchLyrics(track: Track): Promise<LyricsResult | null> {
  let desktopError: string;
  try {
    return await withTimeout(getMusixmatchLyricsDesktop(track), 10000, 'Musixmatch desktop');
  } catch (e) {
    desktopError = errorMessage(e);
  }
  try {
    return await withTimeout(
      getMusixmatchLyricsSignedWithRetry(track, 2),
      14000,
      'Musixmatch community'
    );
  } catch (e) {
    const signedError = errorMessage(e);
    throw new Error(`desktop API: ${desktopError}; community API: ${signedError}`);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '\u2014',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanLyricsText(input: string): string {
  const lines = input.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/contributors?/i.test(t)) return false;
    if (/\blyrics\b/i.test(t) && t.length < 24) return false;
    if (/embed/i.test(t)) return false;
    if (/you might also like/i.test(t)) return false;
    return true;
  });
  return filtered.join('\n');
}

const GENIUS_PRELOADED_STATE_RE = /__PRELOADED_STATE__ = JSON\.parse\('(.*?)'\);/;
const GENIUS_PRELOAD_HTML_RE = /body":{"html":"(.*?)","children"/;

function geniusHtmlToPlain(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n');
  return cleanLyricsText(stripHtml(withBreaks));
}

async function getGeniusLyrics(track: Track): Promise<LyricsResult | null> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const query = new URLSearchParams({
    q: `${title} ${artist}`.trim(),
    page: '1',
    per_page: '10',
  });

  const searchUrls = [
    `https://genius.com/api/search/song?${query}`,
    `https://genius.com/api/search/multi?${query}`,
    `https://genius.com/api/search?${query}`,
  ];
  let searchRes: Response | null = null;
  let lastStatus = 0;
  for (const url of searchUrls) {
    const res = await fetch(url, { method: 'GET', headers: GENIUS_BROWSER_HEADERS });
    lastStatus = res.status;
    if (res.ok) {
      searchRes = res;
      break;
    }
    if (res.status !== 403 && res.status !== 429) {
      throw new Error(geniusHttpError(res.status, 'search'));
    }
  }
  if (!searchRes?.ok) throw new Error(geniusHttpError(lastStatus || 403, 'search'));

  const data = JSON.parse(await searchRes.text());
  const hits: any[] = [
    ...((data?.response?.sections || []).flatMap((sec: any) => sec?.hits || []) as any[]),
    ...(data?.response?.hits || []),
  ].filter((h) => h && (h.type === 'song' || h.result));
  if (!hits.length) throw new Error('No search result on Genius for this title/artist');

  hits.sort((a, b) => {
    const ra = a?.result;
    const rb = b?.result;
    const scoreA =
      (ra?.title?.toLowerCase() === title.toLowerCase() ? 2 : 0) +
      scoreMatch(title, artist, ra?.title || '', ra?.primary_artist?.name || '');
    const scoreB =
      (rb?.title?.toLowerCase() === title.toLowerCase() ? 2 : 0) +
      scoreMatch(title, artist, rb?.title || '', rb?.primary_artist?.name || '');
    return scoreB - scoreA;
  });

  const hit = hits[0]?.result;
  const hitScore = scoreMatch(
    title,
    artist,
    hit?.title || '',
    hit?.primary_artist?.name || '',
    queryDuration(track)
  );
  if (!hit?.path || hit?.primary_artist?.url === 'https://genius.com/artists/Deleted-artist') {
    throw new Error('No usable Genius result for this title/artist');
  }
  if (
    !acceptMatch(
      title,
      artist,
      hit?.title || '',
      hit?.primary_artist?.name || '',
      hitScore,
      queryDuration(track)
    )
  ) {
    throw new Error('Genius search did not return a close enough title/artist match');
  }

  const pageRes = await fetch(`https://genius.com${hit.path}`, {
    method: 'GET',
    headers: { ...GENIUS_BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!pageRes.ok) throw new Error(geniusHttpError(pageRes.status, 'page'));
  const html = await pageRes.text();

  let preloadedRaw: string | undefined;
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!m[1].includes('window.__PRELOADED_STATE__')) continue;
    preloadedRaw = m[1].match(GENIUS_PRELOADED_STATE_RE)?.[1]?.replace(/\\"/g, '"');
    if (preloadedRaw) break;
  }

  const lyricsHtml = preloadedRaw
    ?.match(GENIUS_PRELOAD_HTML_RE)?.[1]
    ?.replace(/\\\//g, '/')
    ?.replace(/\\\\/g, '\\')
    ?.replace(/\\n/g, '\n')
    ?.replace(/\\'/g, "'")
    ?.replace(/\\"/g, '"');

  if (lyricsHtml) {
    const lyrics = geniusHtmlToPlain(lyricsHtml);
    if (lyrics.trim().toLowerCase().replace(/[[\]]/g, '') === 'instrumental') {
      throw new Error('Genius marks this track as instrumental');
    }
    if (lyrics) return { provider: 'LyricsGenius', text: lyrics, matchScore: hitScore };
  }

  if (preloadedRaw && /lyricsPlaceholderReason.{1,5}unreleased/.test(preloadedRaw)) {
    throw new Error('Genius marks this track as unreleased');
  }

  const blocks = Array.from(html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi));
  const parts = blocks.map((m) => cleanLyricsText(stripHtml(m[1]))).filter(Boolean);
  if (parts.length)
    return { provider: 'LyricsGenius', text: parts.join('\n'), matchScore: hitScore };

  throw new Error('Genius page found but lyrics could not be extracted');
}

function cleanQueryTitle(title: string, artist?: string): string {
  let t = title.trim();
  const a = (artist || '').trim();
  if (a) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${escaped}\\s*[-–\u2014|:]+\\s+`, 'iu'), '');
  }
  t = t
    .replace(
      /\(*(official|lyric|lyrics|video|audio|hd|4k|mv|m\/v|visualiser|visualizer)[^)]*\)*/gi,
      ''
    )
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t || title.trim();
}

/** title-only query, strip feat. junk so lyrics search isnt garbage */
export function lyricsSearchTitle(title: string, artist = ''): string {
  try {
    if (localStorage.getItem('zenith_smart_lyrics') === '0') return title.trim();
  } catch {}
  return cleanQueryTitle(title, artist)
    .replace(/\s*[(\[]\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function lyricsSearchArtist(artist: string): string {
  try {
    if (localStorage.getItem('zenith_smart_lyrics') === '0') return firstArtist(artist);
  } catch {}
  return firstArtist(artist)
    .replace(/\s*[(\[]\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.+$/gi, '')
    .replace(/\s+-\s+topic$/i, '')
    .replace(/\s+-\s+vevo$/i, '')
    .trim();
}

function firstArtist(artist: string): string {
  return artist.split('•')[0].split(',')[0].split('&')[0].trim();
}

async function getLyricsForProvider(
  track: Track,
  lang: Language,
  provider: LyricsProvider
): Promise<LyricsResult | null> {
  if (provider === 'YouTube Music') return await getYouTubeMusicLyrics(track, lang);
  if (provider === 'LRCLib') return await getLrclibLyrics(track);
  if (provider === 'Lyrics.ovh') return await getLyricsOvh(track);
  if (provider === 'Musixmatch') return await getMusixmatchLyrics(track);
  if (provider === 'LyricsGenius') return await getGeniusLyrics(track);
  return null;
}

async function searchFallback(query: string, t: TranslationBundle): Promise<Section[]> {
  try {
    const results = await invoke<any[]>('search_ytdlp', { query, limit: 24 });
    const items: Track[] = (results || []).map((r: any) => ({
      id: r.id,
      type: 'track',
      title: r.title || t.unknownTrack,
      artist: r.artist || t.variousArtists,
      cover: r.cover,
      coverSmall: r.cover_small,
      coverLarge: r.cover_large,
    }));
    if (!items.length) return [];
    return [{ title: t.searchResults, items }];
  } catch {
    return [];
  }
}

function pickBestThumbnail(
  thumbs: Array<{ url?: string; width?: number; height?: number }>
): string | null {
  const valid = thumbs.filter((t) => t?.url);
  if (!valid.length) return null;
  const best = valid.reduce(
    (a, b) => ((b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a),
    valid[0]
  );
  return best?.url || valid[valid.length - 1]?.url || null;
}

type Thumb = { url?: string; width?: number; height?: number };

function asThumbList(v: unknown): Thumb[] {
  if (!v) return [];
  if (typeof v === 'string') return [{ url: v }];
  if (Array.isArray(v)) {
    const out: Thumb[] = [];
    for (const item of v) {
      if (typeof item === 'string' && item) out.push({ url: item });
      else if (item && typeof item === 'object' && typeof (item as Thumb).url === 'string') {
        out.push(item as Thumb);
      }
    }
    return out;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.thumbnails)) return asThumbList(o.thumbnails);
    if (typeof o.url === 'string') return [o as Thumb];
  }
  return [];
}

function extractThumbnails(r: any): Thumb[] {
  const paths = [
    r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail,
    r?.thumbnailRenderer?.thumbnail?.thumbnails,
    r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    r?.thumbnail?.thumbnails,
    r?.thumbnailRenderer?.thumbnails,
    r?.customThumbnail?.thumbnails,
    r?.thumbnail,
    r?.thumbnails,
  ];
  for (const p of paths) {
    const list = asThumbList(p);
    if (list.length) return list;
  }
  return [];
}

function extractVideoId(r: any): string | undefined {
  const candidates = [
    r?.playlistItemData?.videoId,
    r?.videoId,
    r?.navigationEndpoint?.watchEndpoint?.videoId,
    r?.playNavigationEndpoint?.watchEndpoint?.videoId,
    r?.doubleTapCommand?.watchEndpoint?.videoId,
    // podcast episodes (musicMultiRowListItemRenderer)
    r?.onTap?.watchEndpoint?.videoId,
    r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId,
  ];
  for (const id of candidates) {
    if (typeof id === 'string' && /^[\w-]{11}$/.test(id)) return id;
  }
  const runLists = [
    r?.title?.runs,
    r?.subtitle?.runs,
    ...((r?.flexColumns as any[]) || []).map(
      (c) => c?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
    ),
  ];
  for (const runs of runLists) {
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const id = run?.navigationEndpoint?.watchEndpoint?.videoId;
      if (typeof id === 'string' && /^[\w-]{11}$/.test(id)) return id;
    }
  }
  return undefined;
}

export function parseClockDuration(text: string): number | undefined {
  const raw = text.trim();
  if (!/^\d+:\d{2}(:\d{2})?$/.test(raw)) return undefined;
  const parts = raw.split(':').map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function extractDurationSec(r: any): number | undefined {
  const texts = [
    r?.lengthText?.runs?.[0]?.text,
    r?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text,
    r?.fixedColumns?.[1]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text,
  ];
  for (const t of texts) {
    if (typeof t === 'string') {
      const sec = parseClockDuration(t);
      if (sec) return sec;
    }
  }
  return undefined;
}

function coversForItem(
  thumbs: Thumb[],
  videoId: string | undefined,
  title: string
): { cover: string; coverSmall: string; coverLarge: string } {
  const bestThumb = thumbs.length > 0 ? pickBestThumbnail(thumbs) : null;
  if (bestThumb) {
    return {
      cover: getOptimizedCover(bestThumb, 'medium') || bestThumb,
      coverSmall: getOptimizedCover(bestThumb, 'small') || bestThumb,
      coverLarge: getOptimizedCover(bestThumb, 'large') || bestThumb,
    };
  }
  return buildFallbackCovers(videoId, title);
}

function buildFallbackCovers(
  videoId: string | undefined,
  title: string
): { cover: string; coverSmall: string; coverLarge: string } {
  if (videoId && videoId !== 'undefined' && videoId !== 'null') {
    return {
      cover: `${YTIMG_BASE}${videoId}/hqdefault.jpg`,
      coverSmall: `${YTIMG_BASE}${videoId}/mqdefault.jpg`,
      coverLarge: `${YTIMG_BASE}${videoId}/hqdefault.jpg`,
    };
  }
  const safeTitle = (title || '?').slice(0, 2);
  const cover = `https://ui-avatars.com/api/?name=${encodeURIComponent(safeTitle)}&background=1a1a2e&color=fff&size=540&bold=true`;
  return { cover, coverSmall: cover, coverLarge: cover };
}

function extractAllTracks(data: any, t: TranslationBundle): Track[] {
  const items: Track[] = [];
  const invalidArtistTokens = new Set([
    '•',
    'Utwór',
    'Film',
    'Wideo',
    'Video',
    'Audio',
    'Song',
    'Album',
    'Single',
    'Playlist',
  ]);

  function walk(obj: any) {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (typeof obj !== 'object') return;

    const r =
      obj.musicResponsiveListItemRenderer ||
      obj.musicTwoRowItemRenderer ||
      obj.musicMultiRowListItemRenderer;
    if (r) {
      const videoId = extractVideoId(r);
      if (videoId) {
        const titleRuns =
          r.title?.runs ||
          r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ||
          [];
        const trackTitle = titleRuns.map((x: any) => x.text).join('') || t.unknownTrack;

        const subtitleRuns =
          r.subtitle?.runs ||
          r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ||
          [];
        const validArtistParts = subtitleRuns
          .map((x: any) => x.text.trim())
          .filter((text: string) => text.length > 0 && !invalidArtistTokens.has(text));
        const artist =
          validArtistParts.length > 0 ? validArtistParts.join(' • ') : t.variousArtists;

        const { cover, coverSmall, coverLarge } = coversForItem(
          extractThumbnails(r),
          videoId,
          trackTitle
        );
        items.push({
          id: videoId,
          type: 'track',
          title: trackTitle,
          artist,
          cover,
          coverSmall,
          coverLarge,
          durationSec: extractDurationSec(r),
        });
      }
    }
    Object.values(obj).forEach(walk);
  }

  walk(data);

  const unique = new Map<string, Track>();
  for (const item of items) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return Array.from(unique.values());
}

function parseShelves(data: any, t: TranslationBundle): Section[] {
  const sections: Section[] = [];
  const invalidArtistTokens = new Set([
    '•',
    'Utwór',
    'Film',
    'Wideo',
    'Video',
    'Audio',
    'Song',
    'Album',
    'Single',
    'Playlist',
  ]);

  function extractItems(contents: any[]): Track[] {
    const items: Track[] = [];
    for (const content of contents || []) {
      // rich home cards, renderer is nested under richItemRenderer.content
      const nested =
        content.richItemRenderer?.content ||
        content.musicResponsiveListItemRenderer ||
        content.musicTwoRowItemRenderer ||
        content.gridVideoRenderer ||
        null;
      const r =
        nested?.musicResponsiveListItemRenderer ||
        nested?.musicTwoRowItemRenderer ||
        nested?.gridVideoRenderer ||
        content.musicResponsiveListItemRenderer ||
        content.musicTwoRowItemRenderer ||
        content.gridVideoRenderer ||
        (nested && !nested.musicTwoRowItemRenderer ? nested : null);
      if (!r || typeof r !== 'object') continue;

      const videoId = extractVideoId(r);
      // the "Shuffle all" button on liked songs is a row too, just a title and a watch endpoint
      if (
        !videoId &&
        r.navigationEndpoint?.watchPlaylistEndpoint &&
        Array.isArray(r.flexColumns) &&
        r.flexColumns.length < 2
      ) {
        continue;
      }
      const playlistId =
        r.navigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
        r.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
        r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
          ?.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
        r.doubleTapCommand?.watchPlaylistEndpoint?.playlistId ||
        r.playlistId;
      let browseId =
        r.navigationEndpoint?.browseEndpoint?.browseId ||
        r.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
        r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.navigationEndpoint?.browseEndpoint?.browseId ||
        r.browseEndpoint?.browseId;
      if (!browseId && playlistId) {
        browseId = toPlaylistBrowseId(String(playlistId));
      }
      // library artist rows point at MPLAUC..., the plain channel id is what the artist page wants
      if (typeof browseId === 'string' && browseId.startsWith('MPLAUC')) {
        browseId = browseId.slice(4);
      }

      if (!videoId && !browseId) continue;

      const titleRuns =
        r.title?.runs ||
        r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ||
        [];
      const trackTitle = titleRuns.map((x: any) => x.text).join('') || t.unknownTrack;

      const subtitleRuns =
        r.subtitle?.runs ||
        r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ||
        [];
      const validArtistParts = subtitleRuns
        .map((x: any) => x.text.trim())
        .filter((text: string) => text.length > 0 && !invalidArtistTokens.has(text));
      const artist = validArtistParts.length > 0 ? validArtistParts.join(' • ') : t.variousArtists;

      const { cover, coverSmall, coverLarge } = coversForItem(
        extractThumbnails(r),
        videoId,
        trackTitle
      );
      const rowBrowse =
        r.navigationEndpoint?.browseEndpoint ||
        r.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint ||
        r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.navigationEndpoint?.browseEndpoint ||
        r.browseEndpoint;
      const pageType =
        rowBrowse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
          ?.pageType;
      const resolved = resolveFeedItem({
        videoId,
        browseId,
        pageType,
        subtitle: artist,
        primaryIsBrowse: Boolean(rowBrowse?.browseId),
      });
      if (!resolved) continue;
      const type = resolved.type;
      items.push({
        id: resolved.id,
        type,
        title: trackTitle,
        artist,
        cover,
        coverSmall,
        coverLarge,
        durationSec: extractDurationSec(r),
      });
    }
    return items;
  }

  function findShelves(obj: any) {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach(findShelves);
      return;
    }
    if (typeof obj !== 'object') return;

    const renderer =
      obj.musicCarouselShelfRenderer ||
      obj.musicShelfRenderer ||
      obj.musicCardShelfRenderer ||
      obj.musicImmersiveCarouselShelfRenderer ||
      obj.musicPlaylistShelfRenderer ||
      obj.musicGridRenderer ||
      obj.gridRenderer ||
      obj.richShelfRenderer ||
      obj.musicShelfContinuation ||
      obj.gridContinuation;
    if (renderer) {
      const title =
        extractFirstText(renderer.header?.musicCarouselShelfBasicHeaderRenderer?.title) ||
        extractFirstText(renderer.header?.musicShelfHeaderRenderer?.title) ||
        extractFirstText(renderer.title) ||
        extractFirstText(renderer.header?.title) ||
        t.defaultSectionTitle;
      if (obj.musicCardShelfRenderer) {
        const card = obj.musicCardShelfRenderer;
        const self = extractItems([
          {
            musicTwoRowItemRenderer: {
              title: card.title,
              subtitle: card.subtitle,
              thumbnailRenderer: card.thumbnail,
              thumbnail: card.thumbnail,
              navigationEndpoint: card.onTap || card.navigationEndpoint,
              overlay: card.thumbnailOverlay || card.overlay,
              playlistItemData: card.playlistItemData,
              playNavigationEndpoint:
                card.onTap ||
                card.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
                  ?.musicPlayButtonRenderer?.playNavigationEndpoint,
            },
          },
        ]);
        const more = extractItems(card.contents || []);
        const all = [...self, ...more];
        if (all.length > 0) sections.push({ title, items: all });
      } else {
        const items = extractItems(renderer.contents || renderer.items);
        if (items.length > 0) sections.push({ title, items });
      }
    }

    if (obj.itemSectionRenderer?.contents && !renderer) {
      const nestedItems = extractItems(obj.itemSectionRenderer.contents);
      if (nestedItems.length > 0) {
        sections.push({ title: t.searchResults, items: nestedItems });
      }
    }

    // another nest, richSection -> shelf
    if (obj.richSectionRenderer?.content) {
      findShelves(obj.richSectionRenderer.content);
    }

    const shelfKeys = [
      'musicCarouselShelfRenderer',
      'musicShelfRenderer',
      'musicCardShelfRenderer',
      'musicImmersiveCarouselShelfRenderer',
      'musicPlaylistShelfRenderer',
      'musicGridRenderer',
      'gridRenderer',
      'richShelfRenderer',
      'musicShelfContinuation',
      'gridContinuation',
    ];
    for (const key of Object.keys(obj)) {
      if (!shelfKeys.includes(key)) {
        findShelves(obj[key]);
      }
    }
  }

  findShelves(data);

  const merged: Section[] = [];
  const byTitle = new Map<string, Section>();
  for (const section of sections) {
    const existing = byTitle.get(section.title);
    if (!existing) {
      byTitle.set(section.title, section);
      merged.push(section);
      continue;
    }
    const seen = new Set(existing.items.map((i) => i.id));
    for (const item of section.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        existing.items.push(item);
      }
    }
  }
  return merged;
}

/** classic walk found nothing, logged-in home json is weirder these days */
function parseRichHome(data: any, t: TranslationBundle): Section[] {
  return parseShelves(data, t);
}

function findLyricsBrowseId(obj: any, lang: Language): string | null {
  const tokens = lang === 'pl' ? ['tekst', 'lyrics'] : ['lyrics'];
  let found: string | null = null;

  const walk = (node: any) => {
    if (!node || found) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;

    const tab = node.tabRenderer;
    if (
      tab?.title &&
      typeof tab.title === 'string' &&
      tokens.some((t) => tab.title.toLowerCase().includes(t))
    ) {
      found = tab.endpoint?.browseEndpoint?.browseId || null;
      if (found) return;
    }

    const text = node?.text;
    if (text?.runs) {
      const runText = text.runs
        .map((r: any) => r.text)
        .join('')
        .toLowerCase();
      if (tokens.some((t) => runText.includes(t))) {
        const id = node.endpoint?.browseEndpoint?.browseId;
        if (id) {
          found = id;
          return;
        }
      }
    }
    Object.values(node).forEach(walk);
  };

  walk(obj);
  return found;
}

function extractLyricsText(obj: any): string | null {
  let lyrics: string | null = null;

  const walk = (node: any) => {
    if (!node || lyrics) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;

    const d = node?.musicDescriptionShelfRenderer?.description ?? node?.description;
    if (d?.runs) {
      const text = d.runs
        .map((r: any) => r.text)
        .join('')
        .trim();
      if (text) {
        lyrics = text;
        return;
      }
    }
    Object.values(node).forEach(walk);
  };

  walk(obj);
  return lyrics;
}
