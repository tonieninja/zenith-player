import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { getRememberLogin, setRememberLogin } from '../utils/rememberLogin';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';
import { ALL_PLUGINS, pluginManager } from '../plugins';

const track = (id: string) => ({
  id,
  type: 'track' as const,
  title: id,
  artist: 'A',
  cover: '',
});

beforeEach(() => localStorage.clear());

describe('session persistence', () => {
  it('remembers the login preference', () => {
    expect(getRememberLogin()).toBe(true);
    setRememberLogin(false);
    expect(getRememberLogin()).toBe(false);
    setRememberLogin(true);
    expect(getRememberLogin()).toBe(true);
  });

  it('restores a persisted queue across reloads', () => {
    savePersistedQueue([track('1'), track('2'), track('3')], 1, 'mix', 42, true);
    const restored = loadPersistedQueue()!;
    expect(restored.index).toBe(1);
    expect(restored.queue.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(restored.progress).toBe(42);
    expect(restored.wasPlaying).toBe(true);
  });

  it('keeps a track duration so the player can show it before playback starts', () => {
    savePersistedQueue(
      [
        {
          id: 'abcabcabcab',
          type: 'track',
          title: 'Get Lucky',
          artist: 'Daft Punk',
          cover: '',
          durationSec: 248,
        },
      ],
      0,
      'Home',
      9,
      false
    );
    const restored = loadPersistedQueue()!;
    expect(restored.progress).toBe(9);
    expect(restored.queue[0].durationSec).toBe(248);
  });
});

describe('plugin defaults / offline', () => {
  it('offline downloads and remember-queue exist', () => {
    const ids = ALL_PLUGINS.map((p) => p.id);
    expect(ids).toContain('offline-downloads');
    expect(ids).toContain('queue-persist');
    expect(ids).toContain('global-hotkeys');
  });

  it('toggling a plugin persists', () => {
    const id = 'share-card';
    pluginManager.reloadFromStorage();
    pluginManager.setEnabled(id, true);
    expect(pluginManager.isEnabled(id)).toBe(true);
    pluginManager.setEnabled(id, false);
    expect(pluginManager.isEnabled(id)).toBe(false);
  });
});
