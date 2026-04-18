import { beforeEach, describe, expect, it, vi } from 'vitest';
import macroGetLucky248 from './fixtures/musixmatch/macro_get_lucky_248.json';
import macroDecoy from './fixtures/musixmatch/macro_decoy_nokia.json';
import macroSzampan from './fixtures/musixmatch/macro_szampan.json';
import searchGetLucky from './fixtures/musixmatch/search_get_lucky.json';
import richsyncRadio from './fixtures/musixmatch/richsync_get_lucky_radio.json';
import subtitleRadio from './fixtures/musixmatch/subtitle_get_lucky_radio.json';
import renew401 from './fixtures/musixmatch/renew_401.json';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', async () => {
  const { tauriFetch } = await import('./helpers/tauriHttp');
  return { fetch: tauriFetch((...a: unknown[]) => httpFetch(...a)) };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import {
  acceptTrack,
  getMusixmatchLyrics,
  isDecoyMatch,
  musixmatchBuildId,
  MXM_HOSTS,
  rankVersions,
  resetMusixmatchState,
  signMusixmatchUrl,
  tokenLooksValid,
} from '../api/musixmatch';
import { getLyrics, lyricsCreditArtist, lyricsSearchTitle, type Track } from '../api/youtube';
import { isAcceptableLyricsMatch, syncLengthFits } from '../utils/lyricsMatch';
import { localizeLyricsReason } from '../utils/lyricsReasons';
import { scopeAllows } from './helpers/tauriHttp';

const TOKEN = 'fixturetoken0123456789abcdef0123456789abcdef0123456789';

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

const tokenOk = { message: { header: { status_code: 200 }, body: { user_token: TOKEN } } };
const tokenCaptcha = { message: { header: { status_code: 401, hint: 'captcha' } } };
const tokenZero = {
  message: { header: { status_code: 200 }, body: { user_token: '0'.repeat(56) } },
};
const notFound = { message: { header: { status_code: 404 }, body: {} } };
const noHits = { message: { header: { status_code: 200 }, body: { track_list: [] } } };

type Route = (u: URL) => unknown;

function routes(map: Record<string, Route>) {
  httpFetch.mockImplementation(async (raw: string) => {
    const u = new URL(String(raw));
    const host = u.hostname.split('.')[0];
    const endpoint = u.pathname.split('/').pop() || '';
    const fn = map[`${host}:${endpoint}`] ?? map[endpoint];
    if (!fn) return reply(notFound);
    const out = fn(u);
    return out && typeof out === 'object' && 'ok' in (out as object) ? out : reply(out);
  });
}

const calls = (host: string, endpoint: string) =>
  httpFetch.mock.calls.filter(([raw]) => {
    const u = new URL(String(raw));
    return u.hostname.startsWith(`${host}.`) && u.pathname.endsWith(`/${endpoint}`);
  });

const isAndroid = (u: URL) => u.searchParams.get('app_id') === 'android-player-v1.0';

const radioEdit = { title: 'Get Lucky (Radio Edit)', artist: 'Daft Punk', durationSec: 248 };
const szampan = { title: 'Szampan', artist: 'sanah', durationSec: 201 };

beforeEach(() => {
  vi.useRealTimers();
  httpFetch.mockReset();
  resetMusixmatchState();
});

describe('Musixmatch decoy and sync checks', () => {
  it('spots the NOKIA decoy a restricted token gets', () => {
    const mc = macroDecoy.message.body.macro_calls as any;
    expect(isDecoyMatch(mc['matcher.track.get'].message, mc['track.lyrics.get'].message)).toBe(
      true
    );
    const real = macroGetLucky248.message.body.macro_calls as any;
    expect(isDecoyMatch(real['matcher.track.get'].message)).toBe(false);
  });

  it('spots the made up decoy words even under an unknown track id', () => {
    const mc = structuredClone(macroSzampan.message.body.macro_calls) as any;
    mc['track.lyrics.get'].message.body.lyrics.lyrics_body = 'Wob gopini den\nTefe woxica fero';
    expect(isDecoyMatch(mc['matcher.track.get'].message, mc['track.lyrics.get'].message)).toBe(
      true
    );
  });

  it('does not trust an all-zero or empty token', () => {
    expect(tokenLooksValid('0'.repeat(56))).toBe(false);
    expect(tokenLooksValid('')).toBe(false);
    expect(tokenLooksValid(TOKEN)).toBe(true);
  });

  it('only accepts synced lyrics timed for a cut of the same length', () => {
    expect(syncLengthFits(248, 248)).toBe(true);
    expect(syncLengthFits(369, 370)).toBe(true);
    expect(syncLengthFits(369, 248)).toBe(false);
    expect(syncLengthFits(257, 276)).toBe(false);
    expect(syncLengthFits(null, 248)).toBe(true);
  });

  it('puts the radio edit first when the playing track is 248 s', () => {
    const ranked = rankVersions(radioEdit, searchGetLucky.message.body.track_list);
    expect(ranked[0].track.track_id).toBe(291887983);
    expect(ranked.some((r) => /Live/.test(r.track.track_name))).toBe(false);
  });

  it('does not take a live or mixed cut for the studio song', () => {
    const q = { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 248 };
    expect(
      isAcceptableLyricsMatch(q, {
        title: 'Get Lucky - Live',
        artist: 'Daft Punk',
        durationSec: 296,
      })
    ).toBe(false);
    expect(
      isAcceptableLyricsMatch(q, {
        title: 'Get Lucky (feat. Pharrell Williams) [Mixed]',
        artist: 'Daft Punk',
        durationSec: 162,
      })
    ).toBe(false);
  });

  it('matches a full artist credit against the lead artist Musixmatch lists', () => {
    const q = {
      title: 'Get Lucky (Radio Edit)',
      artist: 'Daft Punk, Pharrell Williams & Nile Rodgers',
      durationSec: 248,
    };
    const track = {
      track_id: 1,
      track_name: 'Get Lucky',
      artist_name: 'Daft Punk',
      track_length: 370,
    };
    expect(acceptTrack(q, track).ok).toBe(true);
    const band = { title: 'September', artist: 'Earth, Wind & Fire', durationSec: 216 };
    expect(
      acceptTrack(band, {
        track_id: 2,
        track_name: 'September',
        artist_name: 'Earth, Wind & Fire',
        track_length: 215,
      }).ok
    ).toBe(true);
  });
});

describe('Musixmatch requests as the app sends them', () => {
  it('only talks to hosts the http scope allows', () => {
    for (const host of MXM_HOSTS)
      expect(scopeAllows(`https://${host}/ws/1.1/token.get`)).toBe(true);
    expect(scopeAllows('https://example.com/ws/1.1/token.get')).toBe(false);
  });

  it('sends the app user agent and no webview origin', async () => {
    routes({ 'token.get': () => tokenOk, 'macro.subtitles.get': () => macroSzampan });
    await getMusixmatchLyrics(szampan);
    expect(httpFetch.mock.calls.length).toBeGreaterThan(0);
    for (const [raw, init] of httpFetch.mock.calls) {
      expect(new URL(raw).hostname).toBe('apic-appmobile.musixmatch.com');
      expect(init.headers.origin).toBeUndefined();
      expect(init.headers['user-agent']).toMatch(/^Musixmatch\//);
    }
  });

  it('gives up on a response whose body never arrives', async () => {
    vi.useFakeTimers();
    httpFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
      headers: { get: () => null },
    }));
    const pending = getMusixmatchLyrics(szampan);
    const check = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
  });
});

describe('Musixmatch lookup with recorded responses', () => {
  it('finds radio edit sync when the matcher returns the album cut', async () => {
    routes({
      'token.get': () => tokenOk,
      'macro.subtitles.get': () => macroGetLucky248,
      'track.search': () => searchGetLucky,
      'track.richsync.get': (u) =>
        u.searchParams.get('track_id') === '291887983' ? richsyncRadio : notFound,
      'track.subtitle.get': () => subtitleRadio,
    });
    const res = await getMusixmatchLyrics(radioEdit);
    expect(res.trackId).toBe(291887983);
    expect(res.source).toBe('ios-mobile richsync');
    expect(res.synced?.[0]).toEqual({ time: 14.94, text: 'Like the legend of the phoenix, huh' });
    const rs = calls('apic-appmobile', 'track.richsync.get')[0][0];
    expect(new URL(rs).searchParams.get('f_richsync_length')).toBe('248');
    const macro = new URL(calls('apic-appmobile', 'macro.subtitles.get')[0][0]);
    expect(macro.searchParams.get('usertoken')).toBe(TOKEN);
    expect(macro.searchParams.get('app_id')).toBe('mac-ios-v2.0');
  });

  it('serves the track from the screenshot through the same call the player makes', async () => {
    routes({
      'token.get': () => tokenOk,
      'macro.subtitles.get': () => macroGetLucky248,
      'track.search': () => searchGetLucky,
      'track.richsync.get': (u) =>
        u.searchParams.get('track_id') === '291887983' ? richsyncRadio : notFound,
    });
    const track: Track = {
      id: 'getLuckyRadio',
      type: 'track',
      title: 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)',
      artist: 'Daft Punk, Pharrell Williams & Nile Rodgers',
      cover: '',
      durationSec: 248,
    };
    const res = await getLyrics(track, 'en', 'Musixmatch');
    expect(res?.provider).toBe('Musixmatch');
    expect(res?.via).toBe('ios-mobile richsync');
    expect(res?.synced?.[0].text).toMatch(/phoenix/);
    const macro = new URL(calls('apic-appmobile', 'macro.subtitles.get')[0][0]);
    expect(macro.searchParams.get('q_track')).toBe('Get Lucky (Radio Edit)');
    expect(macro.searchParams.get('q_artist')).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
    expect(macro.searchParams.get('q_duration')).toBe('248');
  });

  it('keeps the token between lookups instead of calling token.get again', async () => {
    routes({ 'token.get': () => tokenOk, 'macro.subtitles.get': () => macroSzampan });
    const first = await getMusixmatchLyrics(szampan);
    const second = await getMusixmatchLyrics({ ...szampan, durationSec: 200 });
    expect(first.synced?.[0].text).toBe('Pod górkę mam');
    expect(second.synced?.length).toBeGreaterThan(0);
    expect(calls('apic-appmobile', 'token.get')).toHaveLength(1);
    expect(calls('apic-appmobile', 'macro.subtitles.get')).toHaveLength(2);
  });

  it('is not held back by what an older build left in storage', async () => {
    const later = Date.now() + 24 * 60 * 60 * 1000;
    localStorage.setItem(
      'zenith_mxm_cooldown',
      JSON.stringify({ ios: later, 'ios-mobile': later, desktop: later })
    );
    localStorage.setItem('zenith_mxm_usertoken', JSON.stringify({ token: '0'.repeat(56) }));
    localStorage.setItem('zenith_mxm_client', 'desktop');
    localStorage.setItem(
      'zenith_mxm_tokens',
      JSON.stringify({ 'web-desktop-app-v1.0': { token: '0'.repeat(56), at: Date.now() } })
    );
    routes({ 'token.get': () => tokenOk, 'macro.subtitles.get': () => macroSzampan });
    const res = await getMusixmatchLyrics(szampan);
    expect(res.source).toBe('ios-mobile subtitles');
    expect(localStorage.getItem('zenith_mxm_cooldown')).toBeNull();
    expect(localStorage.getItem('zenith_mxm_usertoken')).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem('zenith_mxm_tokens') || '{}'))).toEqual([
      'mac-ios-v2.0',
    ]);
  });

  it('gives the web api another go when the saved pause is nonsense', async () => {
    localStorage.setItem('zenith_mxm_web_down', String(Date.now() + 24 * 60 * 60 * 1000));
    httpFetch.mockImplementation(async (raw: string) => {
      const u = new URL(String(raw));
      if (u.hostname.startsWith('apic')) return reply(tokenZero);
      return reply('', 503);
    });
    await expect(getMusixmatchLyrics(radioEdit)).rejects.toThrow(/web API/);
  });

  it('answers a repeated question for the same song without another request', async () => {
    routes({ 'token.get': () => tokenOk, 'macro.subtitles.get': () => macroSzampan });
    const [a, b] = await Promise.all([getMusixmatchLyrics(szampan), getMusixmatchLyrics(szampan)]);
    await getMusixmatchLyrics(szampan);
    expect(a).toBe(b);
    expect(calls('apic-appmobile', 'macro.subtitles.get')).toHaveLength(1);
  });

  it('uses the other host with the same token when the first one is down', async () => {
    routes({
      'apic-appmobile:token.get': () => tokenOk,
      'apic-appmobile:macro.subtitles.get': () => reply('bad gateway', 502),
      'apic:macro.subtitles.get': () => macroSzampan,
    });
    const res = await getMusixmatchLyrics(szampan);
    expect(res.source).toBe('ios subtitles');
    expect(calls('apic', 'token.get')).toHaveLength(0);
    expect(new URL(calls('apic', 'macro.subtitles.get')[0][0]).searchParams.get('usertoken')).toBe(
      TOKEN
    );
    httpFetch.mockClear();
    await getMusixmatchLyrics({ ...szampan, durationSec: 200 });
    expect(calls('apic-appmobile', 'macro.subtitles.get')).toHaveLength(0);
  });

  it('gets a new token when the answer is the decoy', async () => {
    let issued = 0;
    routes({
      'token.get': () => {
        issued += 1;
        return {
          message: { header: { status_code: 200 }, body: { user_token: `${issued}${TOKEN}` } },
        };
      },
      'macro.subtitles.get': (u) =>
        u.searchParams.get('usertoken') === `1${TOKEN}` ? macroDecoy : macroSzampan,
    });
    const res = await getMusixmatchLyrics(szampan);
    expect(res.synced?.[0].text).toBe('Pod górkę mam');
    expect(issued).toBe(2);
    const stored = JSON.parse(localStorage.getItem('zenith_mxm_tokens') || '{}');
    expect(stored['mac-ios-v2.0'].token).toBe(`2${TOKEN}`);
  });

  it('moves to the android app id when the ios one keeps getting the decoy', async () => {
    routes({
      'token.get': () => tokenOk,
      'macro.subtitles.get': (u) => (isAndroid(u) ? macroSzampan : macroDecoy),
    });
    const res = await getMusixmatchLyrics(szampan);
    expect(res.source).toBe('android subtitles');
    expect(res.synced?.length).toBeGreaterThan(0);
    expect(localStorage.getItem('zenith_mxm_client')).toBe('android');
  });

  it('sits out a captcha for a while, then tries the same app again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let captcha = true;
    routes({
      'token.get': (u) => (!isAndroid(u) && captcha ? tokenCaptcha : tokenOk),
      'macro.subtitles.get': () => macroSzampan,
    });
    const iosTokenCalls = () =>
      httpFetch.mock.calls.filter(([raw]) => {
        const u = new URL(raw);
        return u.pathname.endsWith('/token.get') && !isAndroid(u);
      }).length;

    expect((await getMusixmatchLyrics(szampan)).source).toBe('android subtitles');
    localStorage.removeItem('zenith_mxm_client');
    await getMusixmatchLyrics({ ...szampan, durationSec: 200 });
    expect(iosTokenCalls()).toBe(1);

    captcha = false;
    localStorage.removeItem('zenith_mxm_client');
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);
    const later = await getMusixmatchLyrics({ ...szampan, durationSec: 202 });
    expect(later.source).toBe('ios-mobile subtitles');
    expect(iosTokenCalls()).toBe(2);
  });

  it('renews the token once when the api says renew', async () => {
    localStorage.setItem(
      'zenith_mxm_tokens',
      JSON.stringify({ 'mac-ios-v2.0': { token: `old${TOKEN}`, at: Date.now() } })
    );
    routes({
      'token.get': () => tokenOk,
      'macro.subtitles.get': (u) =>
        u.searchParams.get('usertoken') === TOKEN ? macroSzampan : renew401,
    });
    const res = await getMusixmatchLyrics(szampan);
    expect(res.source).toBe('ios-mobile subtitles');
    expect(calls('apic-appmobile', 'token.get')).toHaveLength(1);
    expect(calls('apic-appmobile', 'macro.subtitles.get')).toHaveLength(2);
  });

  it('never accepts a wrong song from the matcher', async () => {
    routes({
      'token.get': () => tokenOk,
      'macro.subtitles.get': () => macroSzampan,
      'track.search': () => noHits,
    });
    await expect(getMusixmatchLyrics(radioEdit)).rejects.toThrow(/No matching track/);
    expect(
      httpFetch.mock.calls.every(([raw]) => new URL(raw).hostname.startsWith('apic-appmobile'))
    ).toBe(true);
  });
});

describe('Musixmatch signed web api', () => {
  it('signs like the site: hmac-sha256 over the normalized url plus the utc date', async () => {
    const url =
      'https://www.musixmatch.com/ws/1.1/track.search?app_id=web-desktop-app-v1.0&format=json&q_track=Get%20Lucky&q_artist=Daft+Punk';
    const signed = await signMusixmatchUrl(
      url,
      'fixture-secret-123',
      new Date('2026-11-10T12:00:00Z')
    );
    const u = new URL(signed);
    expect(u.searchParams.get('signature')).toBe('MM8jJJupN/p7VDgjb0gVjGg9JOGLdheipFa3wbHPR50=');
    expect(u.searchParams.get('signature_protocol')).toBe('sha256');
    expect(signed).toContain('q_track=Get+Lucky');
  });

  it('reads the build id from the bundle urls', () => {
    expect(
      musixmatchBuildId(
        '<script src="https://s.mxmcdn.net/mxm-com/prod/1.43.0/_next/static/chunks/0a3swv2oz8k_v.js"></script>'
      )
    ).toBe('1.43.0');
  });

  it('is the last resort and caches the secret per site build', async () => {
    const secret = 'fixture-secret-123';
    const payload = btoa(secret).split('').reverse().join('');
    const html =
      '<script src="https://s.mxmcdn.net/mxm-com/prod/1.43.0/_next/static/chunks/aaa.js"></script>' +
      '<script src="https://s.mxmcdn.net/mxm-com/prod/1.43.0/_next/static/chunks/bbb.js"></script>';
    httpFetch.mockImplementation(async (raw: string) => {
      const u = new URL(String(raw));
      if (u.hostname.startsWith('apic')) return reply(tokenZero);
      if (u.pathname === '/search') return reply(html);
      if (u.pathname.endsWith('/aaa.js')) return reply('var x=1;');
      if (u.pathname.endsWith('/bbb.js')) {
        return reply(`u=i.Buffer.from("${payload}".split("").reverse().join(""),"base64")`);
      }
      if (u.pathname.endsWith('/track.search')) {
        expect(u.searchParams.get('signature')).toBeTruthy();
        return reply(searchGetLucky);
      }
      if (u.pathname.endsWith('/track.richsync.get')) return reply(richsyncRadio);
      return reply(notFound);
    });
    const res = await getMusixmatchLyrics(radioEdit);
    expect(res.source).toBe('web richsync');
    expect(res.synced?.[0].text).toMatch(/phoenix/);
    const saved = JSON.parse(localStorage.getItem('zenith_mxm_secret') || 'null');
    expect(saved).toMatchObject({ secret, build: '1.43.0' });
    expect(saved.chunk).toMatch(/bbb\.js$/);

    httpFetch.mockClear();
    await getMusixmatchLyrics({ ...radioEdit, durationSec: 247 });
    const jsFetches = httpFetch.mock.calls.filter(([raw]) => String(raw).endsWith('.js'));
    expect(jsFetches).toHaveLength(0);
  });

  it('reports both sides once, then leaves the dead web api alone', async () => {
    httpFetch.mockImplementation(async (raw: string) => {
      const u = new URL(String(raw));
      if (u.hostname.startsWith('apic')) return reply(tokenZero);
      return reply('', 503);
    });
    await expect(getMusixmatchLyrics(radioEdit)).rejects.toThrow(
      /^app API: .*restricted token.*; web API: Musixmatch site HTTP 503$/
    );
    httpFetch.mockClear();
    await expect(getMusixmatchLyrics(radioEdit)).rejects.toThrow(/^token\.get failed/);
    expect(httpFetch.mock.calls.some(([raw]) => new URL(raw).hostname.startsWith('www.'))).toBe(
      false
    );
  });

  it('explains the failure in both languages', () => {
    const raw = 'app API: token.get failed (captcha); web API: Musixmatch site HTTP 503';
    expect(localizeLyricsReason(raw, 'en')).toBe(
      'App API: Musixmatch is limiting requests right now, it will retry in a few minutes; web API: Server unavailable (HTTP 503)'
    );
    expect(localizeLyricsReason(raw, 'pl')).toMatch(/^API aplikacji: Musixmatch chwilowo/);
    expect(localizeLyricsReason('Musixmatch request timed out', 'en')).toBe(
      'Musixmatch did not answer in time'
    );
    expect(localizeLyricsReason('Musixmatch request timed out', 'pl')).toBe(
      'Musixmatch nie odpowiedział na czas'
    );
  });
});

describe('titles and artist credits sent to lyrics providers', () => {
  it('keeps the version tag when a title has feat. inside the same brackets', () => {
    expect(
      lyricsSearchTitle('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)')
    ).toBe('Get Lucky (Radio Edit)');
    expect(lyricsSearchTitle('Get Lucky (feat. Pharrell Williams and Nile Rodgers)')).toBe(
      'Get Lucky'
    );
    expect(lyricsSearchTitle('Uptown Funk (feat. Bruno Mars)')).toBe('Uptown Funk');
    expect(lyricsSearchTitle('Stay (with Justin Bieber)')).toBe('Stay');
    expect(lyricsSearchTitle('Tamagotchi feat. Quebonafide')).toBe('Tamagotchi');
    expect(lyricsSearchTitle('Bohemian Rhapsody (Remastered 2011)')).toBe(
      'Bohemian Rhapsody (Remastered 2011)'
    );
  });

  it('asks lyrics providers for the whole credit', () => {
    expect(
      lyricsCreditArtist('Daft Punk, Pharrell Williams & Nile Rodgers • Random Access Memories')
    ).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
    expect(lyricsCreditArtist('Queen - Topic')).toBe('Queen');
  });
});
