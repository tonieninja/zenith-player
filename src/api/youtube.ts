import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { Language, translations } from '../i18n';

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
export async function verifyYtmSession(lang: Language): Promise<boolean> {
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
    return (
      raw.includes('accountItem') ||
      raw.includes('musicMultiSelectMenuItem') ||
      raw.includes('accountSettings') ||
      raw.includes('multiPageMenuRenderer')
    );
  } catch {
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

export const MOODS_AND_MOMENTS = [
  { id: 'chill', title: 'Chill', browseId: 'FEmusic_mood_playlist_Chill', color: '#4285F4' },
  {
    id: 'christmas',
    title: 'Christmas',
    browseId: 'FEmusic_mood_playlist_Christmas',
    color: '#0F9D58',
  },
  { id: 'commute', title: 'Commute', browseId: 'FEmusic_mood_playlist_Commute', color: '#F4B400' },
  {
    id: 'energize',
    title: 'Energize',
    browseId: 'FEmusic_mood_playlist_Energize',
    color: '#F4B400',
  },
  {
    id: 'feelgood',
    title: 'Feel good',
    browseId: 'FEmusic_mood_playlist_Feel%20Good',
    color: '#0F9D58',
  },
  { id: 'focus', title: 'Focus', browseId: 'FEmusic_mood_playlist_Focus', color: '#9C27B0' },
  { id: 'gaming', title: 'Gaming', browseId: 'FEmusic_mood_playlist_Gaming', color: '#009688' },
  { id: 'party', title: 'Party', browseId: 'FEmusic_mood_playlist_Party', color: '#9C27B0' },
  { id: 'romance', title: 'Romance', browseId: 'FEmusic_mood_playlist_Romance', color: '#DB4437' },
  { id: 'sad', title: 'Sad', browseId: 'FEmusic_mood_playlist_Sad', color: '#607D8B' },
  { id: 'sleep', title: 'Sleep', browseId: 'FEmusic_mood_playlist_Sleep', color: '#673AB7' },
  { id: 'workout', title: 'Workout', browseId: 'FEmusic_mood_playlist_Workout', color: '#FF5722' },
];

export const GENRES = [
  { id: 'african', title: 'African', browseId: 'FEmusic_genre_playlist_African', color: '#0F9D58' },
  { id: 'arabic', title: 'Arabic', browseId: 'FEmusic_genre_playlist_Arabic', color: '#FF9800' },
  { id: 'autumn', title: 'Autumn', browseId: 'FEmusic_genre_playlist_Autumn', color: '#795548' },
  { id: 'blues', title: 'Blues', browseId: 'FEmusic_genre_playlist_Blues', color: '#2196F3' },
  {
    id: 'bollywood',
    title: 'Bollywood & Indian',
    browseId: 'FEmusic_genre_playlist_Bollywood',
    color: '#9C27B0',
  },
  {
    id: 'classical',
    title: 'Classical',
    browseId: 'FEmusic_genre_playlist_Classical',
    color: '#E0E0E0',
  },
  {
    id: 'country',
    title: 'Country & Americana',
    browseId: 'FEmusic_genre_playlist_Country',
    color: '#2196F3',
  },
  {
    id: 'dance',
    title: 'Dance & electronic',
    browseId: 'FEmusic_genre_playlist_Dance',
    color: '#00BCD4',
  },
  { id: 'decades', title: 'Decades', browseId: 'FEmusic_genre_playlist_Decades', color: '#4CAF50' },
  { id: 'family', title: 'Family', browseId: 'FEmusic_genre_playlist_Family', color: '#03A9F4' },
  {
    id: 'folk',
    title: 'Folk & acoustic',
    browseId: 'FEmusic_genre_playlist_Folk',
    color: '#00E676',
  },
  { id: 'hiphop', title: 'Hip-hop', browseId: 'FEmusic_genre_playlist_Hip_Hop', color: '#FF5722' },
  {
    id: 'indie',
    title: 'Indie & alternative',
    browseId: 'FEmusic_genre_playlist_Indie',
    color: '#9E9E9E',
  },
  { id: 'jpop', title: 'J-Pop', browseId: 'FEmusic_genre_playlist_J_Pop', color: '#E91E63' },
  { id: 'jazz', title: 'Jazz', browseId: 'FEmusic_genre_playlist_Jazz', color: '#3F51B5' },
  { id: 'kpop', title: 'K-Pop', browseId: 'FEmusic_genre_playlist_K_Pop', color: '#AB47BC' },
  { id: 'latin', title: 'Latin', browseId: 'FEmusic_genre_playlist_Latin', color: '#FFC107' },
  {
    id: 'mandopop',
    title: 'Mandopop & cantopop',
    browseId: 'FEmusic_genre_playlist_Mandopop',
    color: '#F44336',
  },
  { id: 'metal', title: 'Metal', browseId: 'FEmusic_genre_playlist_Metal', color: '#9E9E9E' },
  { id: 'pop', title: 'Pop', browseId: 'FEmusic_genre_playlist_Pop', color: '#E040FB' },
  { id: 'rnb', title: 'R&B & soul', browseId: 'FEmusic_genre_playlist_R_B', color: '#7E57C2' },
  {
    id: 'reggae',
    title: 'Reggae & caribbean',
    browseId: 'FEmusic_genre_playlist_Reggae',
    color: '#FFEB3B',
  },
  { id: 'rock', title: 'Rock', browseId: 'FEmusic_genre_playlist_Rock', color: '#F44336' },
  {
    id: 'soundtracks',
    title: 'Soundtracks & musicals',
    browseId: 'FEmusic_genre_playlist_Soundtracks',
    color: '#00BCD4',
  },
];

const imageCache = new Map<string, number>();
const browseCache = new Map<string, { data: Section[]; ts: number }>();
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
  browseId: string,
  lang: Language,
  cacheKey: string
): Promise<Section[]> {
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
        body: JSON.stringify({ ...buildClientContext(lang, cookie), browseId }),
      },
      8000
    );
    const rawText = await response.text();
    if (response.ok) {
      const result = parsePayload(JSON.parse(rawText));
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await invokeWithTimeout<unknown>(
          'get_stream_url',
          { videoId, fresh: fresh || null },
          28000
        );
        const url = normalizeStreamUrl(raw);
        if (url) return url;
        console.warn('[stream] empty url for', videoId, 'attempt', attempt + 1);
      } catch (err) {
        console.warn('[stream] invoke failed', videoId, 'attempt', attempt + 1, err);
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

/** playlist browse ids are VL + the playlistId, like VLPL... / VLLM / VLRD... */
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
  if (/^(PL|OL|RD|LM|UU)/.test(raw)) return `VL${raw}`;
  return raw;
}

export async function getPlaylistItems(browseId: string, lang: Language): Promise<Track[]> {
  const ids = Array.from(new Set([toPlaylistBrowseId(browseId), browseId].filter(Boolean)));
  for (const id of ids) {
    try {
      const headers = await buildAuthHeaders(lang);
      const response = await fetchWithTimeout(ytmUrl('browse'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...buildClientContext(lang), browseId: id }),
      });
      if (!response.ok) continue;
      let data = JSON.parse(await response.text());
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
      addFrom(data);
      let token = findContinuationToken(data);
      for (let round = 0; token && round < 4; round += 1) {
        const cont = await fetchPlaylistContinuation(token, lang);
        addFrom(cont.data);
        token = cont.next;
      }
      if (tracks.length) return tracks;
    } catch {
      /* nah that id sucked, next */
    }
  }
  return [];
}

// library, you gotta be signed in
export type LibraryCategory = 'landing' | 'playlists' | 'songs' | 'albums' | 'artists' | 'podcasts';

export const LIBRARY_BROWSE_IDS: Record<LibraryCategory, string> = {
  landing: 'FEmusic_library_landing',
  playlists: 'FEmusic_liked_playlists',
  songs: 'FEmusic_liked_videos',
  albums: 'FEmusic_liked_albums',
  artists: 'FEmusic_library_corpus_track_artists',
  podcasts: 'FEmusic_library_non_music_audio_list',
};

export async function getLibrary(category: LibraryCategory, lang: Language): Promise<Section[]> {
  if (!(await isLoggedIn())) return [];
  try {
    return await fetchBrowse(LIBRARY_BROWSE_IDS[category], lang);
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

export async function createPlaylist(
  title: string,
  description: string,
  privacy: PlaylistPrivacy,
  lang: Language
): Promise<string | null> {
  const headers = await buildAuthHeaders(lang);
  if (!headers.Authorization) throw new Error('not signed in');
  const response = await fetch(ytmUrl('playlist/create'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...buildClientContext(lang),
      title,
      description,
      privacyStatus: privacy,
    }),
  });
  if (!response.ok) throw new Error(`playlist/create HTTP ${response.status}`);
  const data = JSON.parse(await response.text());
  return data?.playlistId || null;
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

// cache hits so opening player again is instant
// failures get a short ttl so we can retry later
const lyricsCache = new Map<string, { data: LyricsResult; ts: number; ok: boolean }>();
const LYRICS_CACHE_LIMIT = 20;
const LYRICS_OK_TTL = 20 * 60 * 1000;
const LYRICS_FAIL_TTL = 2 * 60 * 1000;

export async function getLyrics(
  track: Track,
  lang: Language,
  preferred?: LyricsProvider
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
  const result = await getLyricsUncached(track, lang, preferred);
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
  preferred?: LyricsProvider
): Promise<LyricsResult | null> {
  const attempt = async (
    p: LyricsProvider
  ): Promise<{ res: LyricsResult | null; failure: LyricsFailure | null }> => {
    try {
      const res = await withTimeout(getLyricsForProvider(track, lang, p), 8000, p);
      if (res && (res.synced?.length || res.text)) return { res, failure: null };
      return { res: null, failure: { provider: p, reason: 'No lyrics found for this track' } };
    } catch (e) {
      return { res: null, failure: { provider: p, reason: errorMessage(e) } };
    }
  };

  if (preferred && preferred !== 'Auto') {
    const { res, failure } = await attempt(preferred);
    if (res) return res;
    return { provider: preferred, text: null, failures: failure ? [failure] : [] };
  }

  const failures: LyricsFailure[] = [];
  let plainFallback: LyricsResult | null = null;

  // fire both synced sources, usually at least one has timestamps
  const raced = await Promise.all([attempt('LRCLib'), attempt('Musixmatch')]);
  const syncedHits = raced
    .map((x) => x.res)
    .filter((r): r is LyricsResult => Boolean(r?.synced?.length));
  for (const x of raced) if (x.failure) failures.push(x.failure);
  if (syncedHits.length) {
    syncedHits.sort((a, b) => {
      const qa = (a.matchScore ?? 0) * 1000 + Math.min(a.synced?.length || 0, 90);
      const qb = (b.matchScore ?? 0) * 1000 + Math.min(b.synced?.length || 0, 90);
      return qb - qa;
    });
    return syncedHits[0];
  }
  for (const x of raced) {
    if (x.res?.text && !plainFallback) plainFallback = x.res;
  }

  for (const p of ['YouTube Music', 'Lyrics.ovh', 'LyricsGenius'] as LyricsProvider[]) {
    const { res, failure } = await attempt(p);
    if (failure) failures.push(failure);
    if (res?.synced?.length) return res;
    if (res?.text && !plainFallback) plainFallback = res;
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

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const as = new Set(a.split(' ').filter((w) => w.length > 1));
  const bs = new Set(b.split(' ').filter((w) => w.length > 1));
  if (!as.size || !bs.size) return 0;
  let hit = 0;
  for (const w of as) if (bs.has(w)) hit += 1;
  return hit / Math.max(as.size, bs.size);
}

function scoreMatch(
  title: string,
  artist: string,
  candidateTitle: string,
  candidateArtist: string
): number {
  const t = normalizeText(title);
  const a = normalizeText(artist);
  const ct = normalizeText(candidateTitle);
  const ca = normalizeText(candidateArtist);
  if (!t || !ct) return 0;
  let score = 0;
  if (ct === t) score += 8;
  else if (ct.includes(t) || t.includes(ct)) score += 4;
  else score += Math.round(tokenOverlap(t, ct) * 5);
  if (ca && a) {
    if (ca === a) score += 7;
    else if (ca.includes(a) || a.includes(ca)) score += 4;
    else score += Math.round(tokenOverlap(a, ca) * 4);
  }
  if (t.split(' ').filter(Boolean).length <= 1 && ct !== t) score -= 2;
  return score;
}

function minAcceptScore(title: string): number {
  const words = normalizeText(title).split(' ').filter(Boolean);
  if (words.length <= 1) return 8;
  if (words.length === 2) return 6;
  return 4;
}

async function getYoutubeTimedtext(videoId: string, lang: Language): Promise<LyricsLine[] | null> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const langs = lang === 'pl' ? ['pl', 'en', 'en-US', 'en-GB'] : ['en', 'en-US', 'en-GB', 'pl'];
  const kinds = ['', '&kind=asr'];
  for (const lang of langs) {
    for (const kind of kinds) {
      try {
        const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&fmt=vtt&lang=${lang}${kind}`;
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) continue;
        const raw = await response.text();
        if (!raw || raw.length < 20 || !raw.includes('-->')) continue;
        const synced = parseVtt(raw);
        if (synced.length >= 4) return synced;
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
  const browseId = findLyricsBrowseId(data, lang);
  if (!browseId) throw new Error('This video has no Lyrics tab on YouTube Music');
  const lyricsResponse = await fetch(ytmUrl('browse'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...buildClientContext(lang), browseId }),
  });
  if (!lyricsResponse.ok) throw new Error(`YouTube Music lyrics HTTP ${lyricsResponse.status}`);
  const lyricsData = JSON.parse(await lyricsResponse.text());
  const text = extractLyricsText(lyricsData);
  if (!text) throw new Error('Lyrics tab exists but returned no text (possibly region-restricted)');
  return { provider: 'YouTube Music', text };
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
        const score = scoreMatch(
          title,
          artist,
          String(item?.trackName || item?.name || ''),
          String(item?.artistName || item?.artist || '')
        );
        if (score < minAcceptScore(title)) continue;
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
const MXM_APP_ID = 'community-app-v1.0';
const MXM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MXM_SECRET_TTL = 6 * 60 * 60 * 1000;
let mxmSecretCache: { secret: string; ts: number } | null = null;

async function fetchMusixmatchSecret(): Promise<string> {
  if (mxmSecretCache && Date.now() - mxmSecretCache.ts < MXM_SECRET_TTL)
    return mxmSecretCache.secret;

  const bundleUrls: string[] = [];
  const pageRes = await fetch('https://www.musixmatch.com/search', {
    method: 'GET',
    headers: { 'User-Agent': MXM_UA, Cookie: 'mxm_bab=AB' },
  });
  if (pageRes.ok) {
    const html = await pageRes.text();
    for (const m of html.matchAll(/src="([^"]*\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/g)) {
      let src = m[1];
      if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/')) src = 'https://www.musixmatch.com' + src;
      bundleUrls.push(src);
    }
  }

  let lastErr: Error | null = null;
  for (const src of bundleUrls) {
    try {
      const jsRes = await fetch(src, { method: 'GET', headers: { 'User-Agent': MXM_UA } });
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const match = js.match(/from\(\s*"(.*?)"\s*\.split/);
      if (!match) continue;
      const secret = atob(match[1].split('').reverse().join(''));
      mxmSecretCache = { secret, ts: Date.now() };
      return secret;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error('Signature secret not found in Musixmatch app bundle');
}

async function signMusixmatchUrl(url: string): Promise<string> {
  const secret = await fetchMusixmatchSecret();
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
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
    headers: { 'User-Agent': MXM_UA, Accept: 'application/json', Cookie: 'mxm_bab=AB' },
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

async function getMusixmatchLyricsSigned(track: Track): Promise<LyricsResult> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const q = encodeURIComponent(`${title} ${artist}`);
  const searchJson = await musixmatchRequest(
    `track.search?app_id=${MXM_APP_ID}&format=json&q=${q}&f_has_lyrics=true&page_size=10&page=1`
  );
  const list = searchJson?.message?.body?.track_list || [];
  if (!list.length) throw new Error('No matching track in the Musixmatch catalog');
  let best: any = null;
  let bestScore = -1;
  for (const item of list) {
    const cand = item?.track;
    if (!cand) continue;
    const score = scoreMatch(title, artist, cand.track_name || '', cand.artist_name || '');
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (!best || bestScore < minAcceptScore(title)) {
    throw new Error('No matching track in the Musixmatch catalog');
  }

  if (best.has_subtitles && best.commontrack_id) {
    try {
      const subJson = await musixmatchRequest(
        `track.subtitle.get?app_id=${MXM_APP_ID}&format=json&commontrack_id=${best.commontrack_id}&subtitle_format=lrc`
      );
      const body = subJson?.message?.body?.subtitle?.subtitle_body;
      if (body) {
        const synced = parseLrc(String(body));
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

// musixmatch desktop, token refresh the pear-desktop way
const MXM_DESKTOP_BASE = 'https://apic-desktop.musixmatch.com/ws/1.1/';
const MXM_DESKTOP_APP_ID = 'web-desktop-app-v1.0';
const MXM_TOKEN_KEY = 'zenith_mxm_usertoken';
const MXM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MXM_FALSE_POSITIVE_TRACK_ID = 115264642;

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
      if (stored?.token && stored.expires > Date.now()) {
        mxmToken = String(stored.token);
        return stored.token as string;
      }
    } catch {}
  }
  mxmInvalidateToken();
  if (!mxmTokenInflight) {
    mxmTokenInflight = (async () => {
      try {
        const params = new URLSearchParams({ app_id: MXM_DESKTOP_APP_ID });
        const res = await mxmDesktopFetch(`${MXM_DESKTOP_BASE}token.get?${params}`);
        if (!res.ok) throw new Error(`token.get HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        const token = json?.message?.body?.user_token;
        if (!token || String(token).includes('UpgradeOnly')) {
          const hint = json?.message?.header?.hint;
          throw new Error(`token.get failed${hint ? ` (${hint})` : ''}`);
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

async function getMusixmatchLyricsDesktop(track: Track): Promise<LyricsResult> {
  const title = lyricsSearchTitle(track.title, track.artist);
  const artist = lyricsSearchArtist(track.artist);
  const queries: Record<string, string>[] = [
    { q_track: title, q_artist: artist },
    { q_track: title },
    { q_track: title, q_artist: artist.split(/[,&]/)[0]?.trim() || artist },
  ];

  let lastError: Error | null = null;
  for (const q of queries) {
    try {
      const msg = await mxmDesktopQuery('macro.subtitles.get', {
        ...q,
        namespace: 'lyrics_richsynched',
        subtitle_format: 'lrc',
      });
      const macro = msg?.body?.macro_calls;
      if (!macro) continue;

      const trackInfo = macro['matcher.track.get']?.message?.body?.track;
      const lyrics = macro['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
      const subtitle = macro['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle;

      if (!trackInfo || trackInfo.track_id === MXM_FALSE_POSITIVE_TRACK_ID) continue;
      const score = scoreMatch(
        title,
        artist,
        String(trackInfo.track_name || ''),
        String(trackInfo.artist_name || '')
      );
      if (score < minAcceptScore(title)) {
        lastError = new Error(
          `Musixmatch matched "${trackInfo.track_name}" which is the wrong song`
        );
        continue;
      }

      if (subtitle?.subtitle_body) {
        const synced = parseLrc(String(subtitle.subtitle_body));
        if (synced.length > 0) {
          return { provider: 'Musixmatch', text: null, synced, matchScore: score };
        }
      }
      if (lyrics) return { provider: 'Musixmatch', text: String(lyrics), matchScore: score };
      lastError = new Error(
        `Matched "${trackInfo.track_name}" but no lyrics returned (restricted?)`
      );
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
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
    return await getMusixmatchLyricsDesktop(track);
  } catch (e) {
    desktopError = errorMessage(e);
  }
  try {
    return await getMusixmatchLyricsSignedWithRetry(track);
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
  mdash: '—',
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

  const searchRes = await fetch(`https://genius.com/api/search/song?${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!searchRes.ok) throw new Error(`Genius search HTTP ${searchRes.status}`);

  const data = JSON.parse(await searchRes.text());
  const hits: any[] = [...(data?.response?.sections?.[0]?.hits || [])];
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
  const hitScore = scoreMatch(title, artist, hit?.title || '', hit?.primary_artist?.name || '');
  if (!hit?.path || hit?.primary_artist?.url === 'https://genius.com/artists/Deleted-artist') {
    throw new Error('No usable Genius result for this title/artist');
  }
  if (hitScore < minAcceptScore(title)) {
    throw new Error('Genius search did not return a close enough title/artist match');
  }

  const pageRes = await fetch(`https://genius.com${hit.path}`, { method: 'GET' });
  if (!pageRes.ok) throw new Error(`Genius page HTTP ${pageRes.status}`);
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
    t = t.replace(new RegExp(`^${escaped}\\s*[-–—|:]+\\s+`, 'iu'), '');
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

    const r = obj.musicResponsiveListItemRenderer || obj.musicTwoRowItemRenderer;
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
      let type: Track['type'];
      if (videoId) {
        type = 'track';
      } else if (
        browseId!.startsWith('VL') ||
        browseId!.startsWith('PL') ||
        browseId!.startsWith('MPSP')
      ) {
        type = 'playlist';
      } else if (browseId!.startsWith('UC')) {
        const sub = artist.toLowerCase();
        type = sub.includes('profile') || sub.includes('profil') ? 'profile' : 'artist';
      } else if (browseId!.startsWith('MPSPP') || browseId!.startsWith('MPPL')) {
        type = 'playlist';
      } else {
        type = 'album';
      }
      items.push({
        id: videoId || browseId!,
        type,
        title: trackTitle,
        artist,
        cover,
        coverSmall,
        coverLarge,
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
      obj.richShelfRenderer;
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
