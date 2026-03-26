import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { translations } from '../i18n';
import { getActiveLyricIndex } from '../utils/activeLyric';
import { localizeLyricsReason } from '../utils/lyricsReasons';
import { pluginText } from '../utils/pluginI18n';
import { smartShuffle } from '../utils/smartShuffle';
import { getListenStats } from '../plugins/statsTracker';
import { getListeningHistory } from '../plugins/listeningHistory';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';
import {
  abLoopPhase,
  abLoopPlugin,
  clearAbLoop,
  cycleAbLoop,
  getAbLoop,
  registerAbLoopSink,
  setAbPoint,
  subscribeAbLoop,
} from '../plugins/abLoop';
import { DualAudio } from '../audio/dualAudio';
import { ALL_PLUGINS } from '../plugins';
import {
  extractCreatedPlaylistId,
  isEditablePlaylist,
  lyricsSearchTitle,
  lyricsSearchArtist,
  moodBrowseIdFor,
  MOODS_AND_MOMENTS,
  GENRES,
  parseClockDuration,
  toPlainPlaylistId,
  type Track,
} from '../api/youtube';
import { audioOrKnownDuration, barDurationForTrack, knownDurationSec } from '../utils/formatTime';
import { streamStuckMessage } from '../i18n';
import {
  committedPlaylistDescription,
  committedPlaylistTitle,
  isCommitKey,
} from '../utils/playlistForm';
import { AB_LOOP_EARLY_S, abLoopSeekTarget } from '../plugins/abLoop';

const track = (id: string, artist = 'A'): Track => ({
  id,
  type: 'track',
  title: `T${id}`,
  artist,
  cover: '',
});

beforeEach(() => localStorage.clear());

describe('i18n', () => {
  it('polish has every key and none is empty', () => {
    const en = translations.en;
    const pl = translations.pl;
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(pl[key], key).toBeTruthy();
    }
  });
  it('has a session-expired message in both languages', () => {
    expect(translations.en.sessionExpired.toLowerCase()).toContain('expired');
    expect(translations.en.sessionExpired.toLowerCase()).toContain('sign in');
    expect(translations.pl.sessionExpired.toLowerCase()).toContain('wygas');
    expect(translations.pl.sessionExpired).not.toBe(translations.en.sessionExpired);
  });
  it('placeholders survive translation', () => {
    const en = translations.en as Record<string, string>;
    const pl = translations.pl as Record<string, string>;
    for (const key of Object.keys(en)) {
      const ph = en[key].match(/\{\w+\}/g) ?? [];
      for (const p of ph) expect(pl[key], `${key} ${p}`).toContain(p);
    }
  });
  it('every plugin has a polish name and description', () => {
    for (const p of ALL_PLUGINS) {
      const fb = { name: p.name, desc: p.description };
      const txt = pluginText('pl', p.id, fb);
      expect(txt, p.id).not.toBe(fb);
      expect(txt.name.length, p.id).toBeGreaterThan(1);
    }
  });
});

describe('lyrics helpers', () => {
  const synced = [
    { time: 1, text: 'a' },
    { time: 3, text: 'b' },
    { time: 6, text: 'c' },
  ];
  it('active line', () => {
    expect(getActiveLyricIndex(synced, 0)).toBe(-1);
    expect(getActiveLyricIndex(synced, 2)).toBe(0);
    expect(getActiveLyricIndex(synced, 4)).toBe(1);
    expect(getActiveLyricIndex(synced, 100)).toBe(2);
    expect(getActiveLyricIndex([], 10)).toBe(-1);
  });
  it('reasons are localized', () => {
    expect(localizeLyricsReason('LRCLib timed out after 8s', 'pl')).toContain('8 s');
    expect(localizeLyricsReason('No lyrics found for this track', 'pl')).not.toMatch(/found/);
    expect(localizeLyricsReason('', 'pl')).toBe('');
  });
  it('smart title cleanup can be turned off', () => {
    expect(lyricsSearchTitle('Artist - Song (Official Video) feat. X', 'Artist')).toBe('Song');
    localStorage.setItem('zenith_smart_lyrics', '0');
    expect(lyricsSearchTitle('Artist - Song (Official Video)', 'Artist')).toBe(
      'Artist - Song (Official Video)'
    );
    localStorage.removeItem('zenith_smart_lyrics');
  });

  it('strips feat and Topic suffixes from the artist name', () => {
    expect(lyricsSearchArtist('Daft Punk - Topic')).toBe('Daft Punk');
    expect(lyricsSearchArtist('Daft Punk feat. Pharrell Williams')).toBe('Daft Punk');
    expect(lyricsSearchArtist('Sanah - Topic')).toBe('Sanah');
  });
});

describe('youtube ids', () => {
  it('every mood / genre maps to a real browse request', () => {
    for (const m of [...MOODS_AND_MOMENTS, ...GENRES] as Array<{ id: string }>) {
      const id = moodBrowseIdFor(m.id);
      expect(id, m.id).toMatch(/^FEmusic_moods_and_genres_category::.{10,}/);
    }
  });
  it('playlist ids', () => {
    expect(toPlainPlaylistId('VLPL123')).toBe('PL123');
    expect(toPlainPlaylistId('PL123')).toBe('PL123');
    expect(parseClockDuration('6:09')).toBe(369);
    expect(parseClockDuration('1:02:03')).toBe(3723);
    expect(parseClockDuration('2013')).toBeUndefined();
    expect(extractCreatedPlaylistId({ playlistId: 'VLPLmine' })).toBe('PLmine');
    expect(extractCreatedPlaylistId({ actions: [{ playlistId: 'PLnested' }] })).toBe('PLnested');
    expect(extractCreatedPlaylistId({ status: 'STATUS_SUCCEEDED' })).toBeNull();
    expect(knownDurationSec({ durationSec: 248 })).toBe(248);
    expect(knownDurationSec({ durationSec: 0 }, 201)).toBe(201);
    expect(knownDurationSec({})).toBe(0);
    expect(audioOrKnownDuration(Number.NaN, 248)).toBe(248);
    expect(audioOrKnownDuration(0, 248)).toBe(248);
    expect(audioOrKnownDuration(249.2, 248)).toBe(249.2);
    expect(barDurationForTrack(249, 241, false)).toBe(249);
    expect(barDurationForTrack(249, 250.4, true)).toBe(250.4);
    expect(barDurationForTrack(0, 241, false)).toBe(0);
    expect(barDurationForTrack(249, Number.NaN, true)).toBe(249);
    expect(isEditablePlaylist('VLLM')).toBe(false);
    expect(isEditablePlaylist('RDCLAK5uy')).toBe(false);
    expect(isEditablePlaylist('VLPLabc')).toBe(true);
  });
});

describe('plugins storage', () => {
  it('stats survive garbage', () => {
    localStorage.setItem('zenith_listen_stats', '{"trackPlays":null,"totalSeconds":"x"}');
    expect(getListenStats()).toEqual({ totalSeconds: 0, trackPlays: {}, sessions: 0 });
    localStorage.setItem('zenith_listen_stats', 'not json');
    expect(getListenStats().sessions).toBe(0);
  });
  it('history survives garbage', () => {
    localStorage.setItem('zenith_listening_history', '{"a":1}');
    expect(getListeningHistory()).toEqual([]);
    localStorage.setItem('zenith_listening_history', '[null,{"id":"x","title":"t","artist":"a"}]');
    expect(getListeningHistory()).toHaveLength(1);
  });
  it('long queues keep the playing track', () => {
    const q = Array.from({ length: 500 }, (_, i) => track(String(i)));
    savePersistedQueue(q, 450, 'mix', 12, true);
    const restored = loadPersistedQueue()!;
    expect(restored.queue.length).toBeLessThanOrEqual(200);
    expect(restored.queue[restored.index].id).toBe('450');
  });
  it('a-b loop only activates with b after a', () => {
    clearAbLoop();
    setAbPoint('a', 10);
    setAbPoint('b', 5);
    expect(getAbLoop().active).toBe(false);
    setAbPoint('b', 20);
    expect(getAbLoop().active).toBe(true);
    setAbPoint('a', 30);
    expect(getAbLoop().active).toBe(false);
  });

  it('cycles A, then B, then clear on successive clicks', () => {
    clearAbLoop();
    expect(cycleAbLoop(10)).toEqual({ a: 10, b: null, active: false });
    expect(cycleAbLoop(25)).toEqual({ a: 10, b: 25, active: true });
    expect(cycleAbLoop(30)).toEqual({ a: null, b: null, active: false });
  });

  it('third click still clears when B was too close to A to arm the loop', () => {
    clearAbLoop();
    cycleAbLoop(10);
    expect(cycleAbLoop(10.1)).toEqual({ a: 10, b: 10.1, active: false });
    expect(cycleAbLoop(12)).toEqual({ a: null, b: null, active: false });
  });

  it('hands the loop to the audio engine and clears it on a new track', () => {
    clearAbLoop();
    const sent: Array<[number | null, number | null]> = [];
    const phases: string[] = [];
    registerAbLoopSink((a, b) => sent.push([a, b]));
    const off = subscribeAbLoop((s) => phases.push(abLoopPhase(s)));
    cycleAbLoop(10);
    cycleAbLoop(20);
    abLoopPlugin.onTrackChange?.(null, 'x');
    off();
    expect(sent).toEqual([
      [null, null],
      [null, null],
      [10, 20],
      [null, null],
    ]);
    expect(phases).toEqual(['a', 'ab', 'off']);
  });

  it('DualAudio jumps back to A when the playing deck reaches B', () => {
    vi.useFakeTimers();
    try {
      const audio = new DualAudio();
      const el = (audio as unknown as { els: HTMLAudioElement[] }).els[0];
      let now = 15;
      Object.defineProperty(el, 'paused', { configurable: true, get: () => false });
      Object.defineProperty(el, 'currentTime', {
        configurable: true,
        get: () => now,
        set: (v: number) => {
          now = v;
        },
      });
      audio.setLoop(10, 20);
      now = 19.99;
      vi.advanceTimersByTime(5000);
      expect(now).toBe(10);
      now = 25;
      el.dispatchEvent(new Event('timeupdate'));
      expect(now).toBe(10);
      audio.setLoop(null, null);
      now = 25;
      el.dispatchEvent(new Event('timeupdate'));
      expect(now).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stream stuck toast', () => {
  it('drops the sign-in hint when the session is already signed in', () => {
    const en = translations.en;
    const pl = translations.pl;
    expect(streamStuckMessage(en, null, false)).toBe(en.streamUnavailableStuck);
    expect(streamStuckMessage(en, null, true)).toBe(en.streamUnavailableStuckSignedIn);
    expect(streamStuckMessage(en, 'bot', false)).toBe(en.streamBlockedBot);
    expect(streamStuckMessage(en, 'bot', true)).toBe(en.streamBlockedBotSignedIn);
    expect(streamStuckMessage(en, 'network', true)).toBe(en.streamBlockedNetwork);
    expect(en.streamUnavailableStuckSignedIn.toLowerCase()).not.toContain('sign in');
    expect(en.streamBlockedBotSignedIn.toLowerCase()).not.toContain('sign in');
    expect(pl.streamUnavailableStuckSignedIn.toLowerCase()).not.toContain('zaloguj');
    expect(pl.streamBlockedBotSignedIn.toLowerCase()).not.toContain('zaloguj');
  });
});

describe('playlist create title', () => {
  it('prefers the live input value so a click cannot beat the last keystroke', () => {
    expect(committedPlaylistTitle('', 'Summer Mix')).toBe('Summer Mix');
    expect(committedPlaylistTitle('stale', '  Summer Mix  ')).toBe('Summer Mix');
    expect(committedPlaylistTitle('Fallback', '   ')).toBe('Fallback');
    expect(committedPlaylistTitle('', '')).toBe('');
    expect(committedPlaylistDescription('a', 'typed desc')).toBe('typed desc');
  });

  it('does not treat Enter as a submit while an IME is composing', () => {
    expect(isCommitKey({ key: 'Enter' })).toBe(true);
    expect(isCommitKey({ key: 'Enter', isComposing: true })).toBe(false);
    expect(isCommitKey({ key: 'Enter', keyCode: 229 })).toBe(false);
    expect(isCommitKey({ key: 'a' })).toBe(false);
  });
});

describe('A-B loop wrap', () => {
  it('seeks back to A when currentTime has reached B', () => {
    expect(abLoopSeekTarget(19.9, 10, 20)).toBe(null);
    expect(abLoopSeekTarget(20 - AB_LOOP_EARLY_S, 10, 20)).toBe(10);
    expect(abLoopSeekTarget(20, 10, 20)).toBe(10);
    expect(abLoopSeekTarget(25, 10, 20)).toBe(10);
    expect(abLoopSeekTarget(20, 10, 10.1)).toBe(null);
    expect(abLoopSeekTarget(Number.NaN, 10, 20)).toBe(null);
  });
});

describe('smart shuffle', () => {
  it('keeps every track exactly once', () => {
    const q = Array.from({ length: 30 }, (_, i) => track(String(i), i % 3 ? 'X' : 'Y'));
    const s = smartShuffle(q);
    expect(s.map((t) => t.id).sort()).toEqual(q.map((t) => t.id).sort());
  });
});
