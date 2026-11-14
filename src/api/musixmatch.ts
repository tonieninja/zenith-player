import { fetch } from '@tauri-apps/plugin-http';
import {
  isAcceptableLyricsMatch,
  scoreLyricsMatch,
  syncLengthFits,
  type LyricsMatchQuery,
} from '../utils/lyricsMatch';
import {
  collectMusixmatchBundleUrls,
  extractMusixmatchSecretFromJs,
  LYRICS_BROWSER_UA,
  MXM_SECRET_MISSING,
} from '../utils/lyricsProviders';
import { parseMusixmatchSynced, type LyricsLine } from '../utils/lyricsParse';

export type MxmQuery = LyricsMatchQuery & { durationSec?: number };

export type MxmLyrics = {
  text: string | null;
  synced?: LyricsLine[];
  matchScore: number;
  trackId?: number;
  source: string;
};

type App = { appId: string; headers: Record<string, string> };
type Client = { id: string; host: string; app: App };

const APP_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: '',
};

const IOS: App = {
  appId: 'mac-ios-v2.0',
  headers: {
    ...APP_HEADERS,
    'User-Agent': 'Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0',
    'x-mxm-app-version': '10.1.1',
  },
};

const ANDROID: App = {
  appId: 'android-player-v1.0',
  headers: { ...APP_HEADERS, 'User-Agent': 'okhttp/4.12.0' },
};

export const MXM_CLIENTS: Client[] = [
  { id: 'ios-mobile', host: 'apic-appmobile.musixmatch.com', app: IOS },
  { id: 'ios', host: 'apic.musixmatch.com', app: IOS },
  { id: 'android', host: 'apic.musixmatch.com', app: ANDROID },
];

const WEB_HOST = 'www.musixmatch.com';
const WEB_APP_ID = 'web-desktop-app-v1.0';

export const MXM_HOSTS = [
  ...new Set([...MXM_CLIENTS.map((c) => c.host), WEB_HOST, 's.mxmcdn.net']),
];

export const MXM_DECOY_TRACK_IDS = new Set([115264642, 226291677]);
const MXM_DECOY_LYRICS_IDS = new Set([35776330]);
const MXM_DECOY_TEXT = 'wob gopini den tefe woxica';

const TOKENS_KEY = 'zenith_mxm_tokens';
const LAST_CLIENT_KEY = 'zenith_mxm_client';
const SECRET_KEY = 'zenith_mxm_secret';
const WEB_DOWN_KEY = 'zenith_mxm_web_down';
const STALE_KEYS = ['zenith_mxm_usertoken', 'zenith_mxm_cooldown'];
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTCHA_COOLDOWN_MS = 2 * 60 * 1000;
const SECRET_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const WEB_DOWN_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6000;

export class MxmAuthError extends Error {}
export class MxmMiss extends Error {}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

let staleKeysDropped = false;
function dropStaleKeys() {
  if (staleKeysDropped) return;
  staleKeysDropped = true;
  try {
    for (const k of STALE_KEYS) localStorage.removeItem(k);
  } catch {}
}

type TokenEntry = { token: string; at: number };

export function tokenLooksValid(token: unknown): token is string {
  const s = String(token || '');
  return s.length >= 20 && !s.includes('UpgradeOnly') && !/^(.)\1*$/.test(s);
}

function storedToken(app: App): string | null {
  const all = readJson<Record<string, TokenEntry>>(TOKENS_KEY, {});
  const hit = all[app.appId];
  if (!hit || !tokenLooksValid(hit.token)) return null;
  if (Date.now() - hit.at > TOKEN_MAX_AGE_MS) return null;
  return hit.token;
}

function storeToken(app: App, token: string | null) {
  const all = readJson<Record<string, TokenEntry>>(TOKENS_KEY, {});
  for (const id of Object.keys(all)) {
    if (!MXM_CLIENTS.some((c) => c.app.appId === id)) delete all[id];
  }
  if (token) all[app.appId] = { token, at: Date.now() };
  else delete all[app.appId];
  writeJson(TOKENS_KEY, all);
}

const cooldowns = new Map<string, number>();

function coolingDown(app: App): boolean {
  return (cooldowns.get(app.appId) ?? 0) > Date.now();
}

function coolDown(app: App) {
  cooldowns.set(app.appId, Date.now() + CAPTCHA_COOLDOWN_MS);
}

export function clientOrder(): Client[] {
  let last = '';
  try {
    last = localStorage.getItem(LAST_CLIENT_KEY) || '';
  } catch {}
  const first = MXM_CLIENTS.find((c) => c.id === last);
  return first ? [first, ...MXM_CLIENTS.filter((c) => c !== first)] : [...MXM_CLIENTS];
}

function rememberClient(client: Client) {
  try {
    localStorage.setItem(LAST_CLIENT_KEY, client.id);
  } catch {}
}

type Reply = { status: number; ok: boolean; text: string };

async function get(url: string, headers: Record<string, string>): Promise<Reply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Musixmatch request timed out'));
    }, REQUEST_TIMEOUT_MS);
  });
  const reply = (async () => {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    return { status: res.status, ok: res.ok, text: await res.text() };
  })();
  reply.catch(() => {});
  try {
    return await Promise.race([reply, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Message = { header: Record<string, any>; body: any };

async function request(
  client: Client,
  endpoint: string,
  params: Record<string, string>
): Promise<Message> {
  const qs = new URLSearchParams({ app_id: client.app.appId, format: 'json', ...params });
  const res = await get(`https://${client.host}/ws/1.1/${endpoint}?${qs}`, client.app.headers);
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  let message: Message | undefined;
  try {
    message = JSON.parse(res.text)?.message;
  } catch {}
  if (!message?.header) throw new Error(`${endpoint} returned no json`);
  return message;
}

const inflightTokens = new Map<string, Promise<string>>();

async function fetchToken(client: Client): Promise<string> {
  const m = await request(client, 'token.get', {
    user_language: 'en',
    t: String(Date.now()),
  });
  const token = m.body?.user_token;
  if (m.header.hint === 'captcha') {
    coolDown(client.app);
    throw new MxmAuthError('token.get failed (captcha)');
  }
  if (!tokenLooksValid(token)) {
    throw new MxmAuthError(`token.get failed (${m.header.hint || 'restricted token'})`);
  }
  storeToken(client.app, token);
  return token;
}

async function ensureToken(client: Client): Promise<string> {
  const stored = storedToken(client.app);
  if (stored) return stored;
  const key = client.app.appId;
  let job = inflightTokens.get(key);
  if (!job) {
    job = fetchToken(client).finally(() => inflightTokens.delete(key));
    inflightTokens.set(key, job);
  }
  return job;
}

async function call(
  client: Client,
  endpoint: string,
  params: Record<string, string>,
  retried = false
): Promise<Message> {
  const token = await ensureToken(client);
  const message = await request(client, endpoint, { usertoken: token, ...params });
  if (message.header.status_code === 401) {
    if (storedToken(client.app) === token) storeToken(client.app, null);
    if (message.header.hint === 'captcha') {
      coolDown(client.app);
      throw new MxmAuthError(`${endpoint} failed (captcha)`);
    }
    if (!retried) return call(client, endpoint, params, true);
    throw new MxmAuthError(`${endpoint} failed (${message.header.hint || 'unauthorized'})`);
  }
  return message;
}

function looksLikeDecoyText(body: unknown): boolean {
  const flat = String(body || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return flat.startsWith(MXM_DECOY_TEXT);
}

export function isDecoyMatch(matcher: Message | undefined, lyrics?: Message): boolean {
  const track = matcher?.body?.track;
  if (!track) return false;
  if (MXM_DECOY_TRACK_IDS.has(Number(track.track_id))) return true;
  const lyr = lyrics?.body?.lyrics;
  if (MXM_DECOY_LYRICS_IDS.has(Number(lyr?.lyrics_id))) return true;
  if (looksLikeDecoyText(lyr?.lyrics_body)) return true;
  return (
    matcher?.header?.confidence == null && !(Number(track.track_length) > 0) && !track.track_isrc
  );
}

function candidateDuration(track: any): number | undefined {
  const n = Number(track?.track_length);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function artistVariants(artist: string): string[] {
  const first = artist.split(/\s*(?:,|&|\bx\b|\band\b|\bi\b|\bfeat\.?|\bft\.?)\s*/i)[0]?.trim();
  return Array.from(new Set([artist.trim(), first].filter((a): a is string => Boolean(a))));
}

export function acceptTrack(q: MxmQuery, track: any): { ok: boolean; score: number } {
  let best = { ok: false, score: 0 };
  if (!track || MXM_DECOY_TRACK_IDS.has(Number(track.track_id))) return best;
  const cand = {
    title: String(track.track_name || ''),
    artist: String(track.artist_name || ''),
    durationSec: candidateDuration(track),
  };
  for (const artist of artistVariants(q.artist)) {
    const query = { title: q.title, artist, durationSec: q.durationSec };
    const score = scoreLyricsMatch(query, cand);
    const ok = isAcceptableLyricsMatch(query, cand, score);
    if (ok === best.ok ? score > best.score : ok) best = { ok, score };
  }
  return best;
}

export function rankVersions(q: MxmQuery, list: any[]): { track: any; score: number }[] {
  const out: { track: any; score: number; fits: boolean }[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const track = item?.track ?? item;
    const id = Number(track?.track_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const { ok, score: s } = acceptTrack(q, track);
    if (!ok) continue;
    out.push({ track, score: s, fits: syncLengthFits(candidateDuration(track), q.durationSec) });
  }
  const syncRank = (t: any) => (t.has_richsync ? 2 : 0) + (t.has_subtitles ? 1 : 0);
  out.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return syncRank(b.track) - syncRank(a.track);
  });
  return out.map(({ track, score: s }) => ({ track, score: s }));
}

type Sync = { lines: LyricsLine[]; kind: 'richsync' | 'subtitles' };

function syncedFromBody(body: unknown, length: unknown, durationSec?: number): LyricsLine[] | null {
  if (!body || looksLikeDecoyText(body)) return null;
  if (!syncLengthFits(Number(length) || null, durationSec)) return null;
  const lines = parseMusixmatchSynced(String(body));
  return lines.length ? lines : null;
}

export function lyricsFromMacro(
  calls: Record<string, { message: Message }>,
  durationSec?: number
): { synced: Sync | null; text: string | null; instrumental: boolean } {
  const rich = calls['track.richsync.get']?.message?.body?.richsync;
  const sub = calls['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle;
  const lyr = calls['track.lyrics.get']?.message?.body?.lyrics;
  const track = calls['matcher.track.get']?.message?.body?.track;
  const richLines = syncedFromBody(rich?.richsync_body, rich?.richsync_length, durationSec);
  const subLines = richLines
    ? null
    : syncedFromBody(sub?.subtitle_body, sub?.subtitle_length, durationSec);
  const synced: Sync | null = richLines
    ? { lines: richLines, kind: 'richsync' }
    : subLines
      ? { lines: subLines, kind: 'subtitles' }
      : null;
  const text = lyr?.lyrics_body ? String(lyr.lyrics_body) : null;
  return { synced, text, instrumental: Boolean(track?.instrumental || lyr?.instrumental) };
}

function lengthFilter(prefix: 'richsync' | 'subtitle', durationSec?: number) {
  if (!durationSec) return {};
  const d = Math.round(durationSec);
  return {
    [`f_${prefix}_length`]: String(d),
    [`f_${prefix}_length_max_deviation`]: String(Math.round(Math.max(4, d * 0.025))),
  };
}

type Caller = (endpoint: string, params: Record<string, string>) => Promise<Message>;

async function syncedForTrack(api: Caller, track: any, durationSec?: number): Promise<Sync | null> {
  const id = String(track.track_id);
  if (track.has_richsync) {
    try {
      const m = await api('track.richsync.get', {
        track_id: id,
        ...lengthFilter('richsync', durationSec),
      });
      const r = m.body?.richsync;
      const lines = syncedFromBody(r?.richsync_body, r?.richsync_length, durationSec);
      if (lines) return { lines, kind: 'richsync' };
    } catch (e) {
      if (e instanceof MxmAuthError) throw e;
    }
  }
  if (track.has_subtitles) {
    try {
      const m = await api('track.subtitle.get', {
        track_id: id,
        subtitle_format: 'lrc',
        ...lengthFilter('subtitle', durationSec),
      });
      const s = m.body?.subtitle;
      const lines = syncedFromBody(s?.subtitle_body, s?.subtitle_length, durationSec);
      if (lines) return { lines, kind: 'subtitles' };
    } catch (e) {
      if (e instanceof MxmAuthError) throw e;
    }
  }
  return null;
}

async function searchVersions(api: Caller, q: MxmQuery): Promise<{ track: any; score: number }[]> {
  const shapes: Record<string, string>[] = artistVariants(q.artist).map((a) => ({
    q_track: q.title,
    q_artist: a,
  }));
  shapes.push({ q_track_artist: `${q.title} ${q.artist}` });
  for (const shape of shapes) {
    const m = await api('track.search', {
      ...shape,
      f_has_lyrics: '1',
      s_track_rating: 'desc',
      page_size: '15',
      page: '1',
    });
    const ranked = rankVersions(q, m.body?.track_list || []);
    if (ranked.length) return ranked;
  }
  return [];
}

async function lookupWith(client: Client, q: MxmQuery, retried = false): Promise<MxmLyrics> {
  const api: Caller = (endpoint, params) => call(client, endpoint, params);
  const found = (
    v: { track: any; score: number },
    kind: string,
    lyrics: Pick<MxmLyrics, 'text' | 'synced'>
  ): MxmLyrics => ({
    ...lyrics,
    matchScore: v.score,
    trackId: v.track.track_id,
    source: `${client.id} ${kind}`,
  });

  let matched: { track: any; score: number } | null = null;
  let fromMacro: ReturnType<typeof lyricsFromMacro> | null = null;
  for (const artist of artistVariants(q.artist)) {
    const params: Record<string, string> = {
      q_track: q.title,
      q_artist: artist,
      namespace: 'lyrics_richsynched',
      subtitle_format: 'lrc',
      optional_calls: 'track.richsync',
    };
    if (q.durationSec) params.q_duration = String(Math.round(q.durationSec));
    const m = await api('macro.subtitles.get', params);
    const calls = m.body?.macro_calls;
    if (!calls) continue;
    const matcher = calls['matcher.track.get']?.message;
    if (isDecoyMatch(matcher, calls['track.lyrics.get']?.message)) {
      storeToken(client.app, null);
      if (!retried) return lookupWith(client, q, true);
      coolDown(client.app);
      throw new MxmAuthError('Musixmatch answered with a decoy track (restricted token)');
    }
    const track = matcher?.body?.track;
    const verdict = acceptTrack(q, track);
    if (verdict.ok) {
      matched = { track, score: verdict.score };
      fromMacro = lyricsFromMacro(calls, q.durationSec);
      break;
    }
  }

  if (matched && fromMacro?.synced) {
    return found(matched, fromMacro.synced.kind, { text: null, synced: fromMacro.synced.lines });
  }
  if (fromMacro?.instrumental && !fromMacro.text) {
    throw new MxmMiss('Musixmatch marks this track as instrumental');
  }

  let versions: { track: any; score: number }[] = [];
  try {
    versions = await searchVersions(api, q);
  } catch (e) {
    if (e instanceof MxmAuthError || !matched) throw e;
  }
  for (const v of versions.slice(0, 3)) {
    if (!syncLengthFits(candidateDuration(v.track), q.durationSec)) continue;
    if (!v.track.has_richsync && !v.track.has_subtitles) continue;
    const sync = await syncedForTrack(api, v.track, q.durationSec);
    if (sync) return found(v, sync.kind, { text: null, synced: sync.lines });
  }

  if (matched && fromMacro?.text) return found(matched, 'text', { text: fromMacro.text });
  const best = versions[0];
  if (best) {
    const m = await api('track.lyrics.get', { track_id: String(best.track.track_id) });
    const body = m.body?.lyrics?.lyrics_body;
    if (body && !looksLikeDecoyText(body)) return found(best, 'text', { text: String(body) });
    throw new MxmMiss(
      `Matched "${best.track.track_name}" but Musixmatch returned no lyrics body (restricted?)`
    );
  }
  throw new MxmMiss('No matching track in the Musixmatch catalog');
}

type SecretEntry = { secret: string; build: string; chunk: string; at: number };
let secretMemo: SecretEntry | null = null;
let webDownUntil = 0;

function webIsDown(): boolean {
  if (!webDownUntil) webDownUntil = Number(readJson<number>(WEB_DOWN_KEY, 0)) || 0;
  if (webDownUntil - Date.now() > WEB_DOWN_MS) webDownUntil = 0;
  return webDownUntil > Date.now();
}

function markWebDown() {
  webDownUntil = Date.now() + WEB_DOWN_MS;
  writeJson(WEB_DOWN_KEY, webDownUntil);
}

const WEB_HEADERS = { 'User-Agent': LYRICS_BROWSER_UA, Cookie: 'mxm_bab=AB' };

export function musixmatchBuildId(html: string): string {
  return html.match(/\/mxm-com\/[^/"']+\/([\d.]+)\/_next\//)?.[1] || '';
}

async function webSecret(force = false): Promise<string> {
  const cached = secretMemo || readJson<SecretEntry | null>(SECRET_KEY, null);
  if (!force && cached?.secret && Date.now() - cached.at < SECRET_MAX_AGE_MS) {
    secretMemo = cached;
    return cached.secret;
  }
  const page = await get(`https://${WEB_HOST}/search`, { ...WEB_HEADERS, Accept: 'text/html' });
  if (!page.ok) {
    if (cached?.secret) return cached.secret;
    throw new Error(`Musixmatch site HTTP ${page.status}`);
  }
  const build = musixmatchBuildId(page.text);
  if (!force && cached?.secret && build && cached.build === build) {
    secretMemo = { ...cached, at: Date.now() };
    writeJson(SECRET_KEY, secretMemo);
    return cached.secret;
  }
  const urls = collectMusixmatchBundleUrls(page.text);
  if (cached?.chunk) {
    const i = urls.indexOf(cached.chunk);
    if (i > 0) urls.unshift(...urls.splice(i, 1));
  }
  const candidates = urls.slice(0, 24);
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    const found = await Promise.all(
      batch.map(async (src) => {
        try {
          const js = await get(src, { 'User-Agent': LYRICS_BROWSER_UA });
          if (!js.ok) return null;
          const secret = extractMusixmatchSecretFromJs(js.text);
          return secret ? { secret, chunk: src } : null;
        } catch {
          return null;
        }
      })
    );
    const hit = found.find(Boolean);
    if (hit) {
      secretMemo = { secret: hit.secret, chunk: hit.chunk, build, at: Date.now() };
      writeJson(SECRET_KEY, secretMemo);
      return hit.secret;
    }
  }
  throw new Error(MXM_SECRET_MISSING);
}

function utcStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function signMusixmatchUrl(
  url: string,
  secret: string,
  now = new Date()
): Promise<string> {
  const u = new URL(url);
  u.searchParams.delete('signature');
  u.searchParams.delete('signature_protocol');
  u.search = `?${u.searchParams.toString()}`;
  const plain = u.toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(plain + utcStamp(now)))
  );
  let bin = '';
  for (let i = 0; i < sig.length; i += 1) bin += String.fromCharCode(sig[i]);
  u.searchParams.set('signature', btoa(bin));
  u.searchParams.set('signature_protocol', 'sha256');
  return u.toString();
}

async function webCall(
  endpoint: string,
  params: Record<string, string>,
  retried = false
): Promise<Message> {
  const secret = await webSecret(retried);
  const qs = new URLSearchParams({ app_id: WEB_APP_ID, format: 'json', ...params });
  const url = await signMusixmatchUrl(`https://${WEB_HOST}/ws/1.1/${endpoint}?${qs}`, secret);
  const res = await get(url, { ...WEB_HEADERS, Accept: 'application/json' });
  if (!res.ok) throw new Error(`Community API HTTP ${res.status}`);
  let message: Message | undefined;
  try {
    message = JSON.parse(res.text)?.message;
  } catch {}
  if (!message?.header) throw new Error('Community API unavailable');
  const status = message.header.status_code;
  if (status === 401 && !retried) return webCall(endpoint, params, true);
  if (status !== 200) {
    const hint = message.header.hint;
    throw new Error(`API status ${status}${hint ? ` (${hint})` : ''}`);
  }
  return message;
}

async function lookupWeb(q: MxmQuery): Promise<MxmLyrics> {
  let versions: { track: any; score: number }[] = [];
  for (const artist of artistVariants(q.artist)) {
    const m = await webCall('track.search', {
      q_track: q.title,
      q_artist: artist,
      f_has_lyrics: 'true',
      page_size: '15',
      page: '1',
    });
    versions = rankVersions(q, m.body?.track_list || []);
    if (versions.length) break;
  }
  if (!versions.length) throw new MxmMiss('No matching track in the Musixmatch catalog');
  for (const v of versions.slice(0, 2)) {
    if (!syncLengthFits(candidateDuration(v.track), q.durationSec)) continue;
    const sync = await syncedForTrack(webCall, v.track, q.durationSec).catch(() => null);
    if (sync) {
      return {
        text: null,
        synced: sync.lines,
        matchScore: v.score,
        trackId: v.track.track_id,
        source: `web ${sync.kind}`,
      };
    }
  }
  const best = versions[0];
  const m = await webCall('track.lyrics.get', { track_id: String(best.track.track_id) });
  const body = m.body?.lyrics?.lyrics_body;
  if (body) {
    return {
      text: String(body),
      matchScore: best.score,
      trackId: best.track.track_id,
      source: 'web text',
    };
  }
  throw new MxmMiss(
    `Matched "${best.track.track_name}" but Musixmatch returned no lyrics body (restricted?)`
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const recent = new Map<string, { at: number; job: Promise<MxmLyrics> }>();
const RECENT_MS = 10 * 60 * 1000;
const RECENT_LIMIT = 30;

export function getMusixmatchLyrics(q: MxmQuery): Promise<MxmLyrics> {
  dropStaleKeys();
  const key = `${q.title}\n${q.artist}\n${Math.round(q.durationSec || 0)}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < RECENT_MS) return hit.job;
  const job = lookup(q);
  recent.set(key, { at: Date.now(), job });
  job.catch(() => {
    if (recent.get(key)?.job === job) recent.delete(key);
  });
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value as string);
  return job;
}

async function lookup(q: MxmQuery): Promise<MxmLyrics> {
  const errors: string[] = [];
  for (const client of clientOrder()) {
    if (coolingDown(client.app)) {
      errors.push('token request is cooling down after a captcha');
      continue;
    }
    try {
      const res = await lookupWith(client, q);
      rememberClient(client);
      return res;
    } catch (e) {
      if (e instanceof MxmMiss) {
        rememberClient(client);
        throw e;
      }
      errors.push(message(e));
    }
  }
  const appError = errors[0] || 'no client';
  if (webIsDown()) throw new Error(appError);
  try {
    return await lookupWeb(q);
  } catch (e) {
    if (e instanceof MxmMiss) throw e;
    markWebDown();
    throw new Error(`app API: ${appError}; web API: ${message(e)}`, { cause: e });
  }
}

export function resetMusixmatchState() {
  inflightTokens.clear();
  cooldowns.clear();
  recent.clear();
  secretMemo = null;
  webDownUntil = 0;
  staleKeysDropped = false;
  try {
    for (const k of [TOKENS_KEY, LAST_CLIENT_KEY, SECRET_KEY, WEB_DOWN_KEY])
      localStorage.removeItem(k);
  } catch {}
}
