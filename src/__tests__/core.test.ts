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
import { getActiveLyricIndex } from '../utils/activeLyricIndex';
import { localizeLyricsReason } from '../utils/lyricsReasons';
import { pluginText } from '../utils/pluginI18n';
import { smartShuffle } from '../utils/smartShuffle';
import { getListenStats } from '../plugins/statsTracker';
import { getListeningHistory } from '../plugins/listeningHistory';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';
import { clearAbLoop, getAbLoop, setAbPoint } from '../plugins/abLoop';
import { ALL_PLUGINS } from '../plugins';
import {
  isEditablePlaylist,
  lyricsSearchTitle,
  moodBrowseIdFor,
  MOODS_AND_MOMENTS,
  GENRES,
  parseClockDuration,
  toPlainPlaylistId,
  type Track,
} from '../api/youtube';

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
});

describe('smart shuffle', () => {
  it('keeps every track exactly once', () => {
    const q = Array.from({ length: 30 }, (_, i) => track(String(i), i % 3 ? 'X' : 'Y'));
    const s = smartShuffle(q);
    expect(s.map((t) => t.id).sort()).toEqual(q.map((t) => t.id).sort());
  });
});
