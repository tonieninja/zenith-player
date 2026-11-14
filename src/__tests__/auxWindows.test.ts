import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));

import { pluginManager } from '../plugins';

const none = async () => false;
const all = async () => true;

describe('plugin windows', () => {
  it('reopen after a normal start when their plugin was left on', async () => {
    pluginManager.setEnabled('mini-player', true);
    invoke.mockClear();
    await pluginManager.restoreWindows(false, [], none);
    expect(pluginManager.isEnabled('mini-player')).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_mini_player'));
  });

  it('turn the plugin off when the window was closed while the main window was freed', async () => {
    pluginManager.setEnabled('mini-player', true);
    await pluginManager.restoreWindows(true, [], none);
    expect(pluginManager.isEnabled('mini-player')).toBe(false);

    pluginManager.setEnabled('second-screen-lyrics', true);
    await pluginManager.restoreWindows(false, ['lyrics-second'], all);
    expect(pluginManager.isEnabled('second-screen-lyrics')).toBe(false);
  });

  it('keep the plugin on while its window still exists', async () => {
    pluginManager.setEnabled('lyrics-overlay', true);
    await pluginManager.restoreWindows(true, [], all);
    expect(pluginManager.isEnabled('lyrics-overlay')).toBe(true);
    pluginManager.markWindowClosed('lyrics-overlay');
    expect(pluginManager.isEnabled('lyrics-overlay')).toBe(false);
  });

  it('close a window that finished opening after its plugin was switched off', async () => {
    pluginManager.setEnabled('mini-player', false);
    invoke.mockClear();
    pluginManager.setEnabled('mini-player', true);
    pluginManager.setEnabled('mini-player', false);
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter((c) => (c as unknown[])[0] === 'close_window').length).toBe(2)
    );
  });

  it('let a freshly enabled window finish building before checking it', async () => {
    pluginManager.setEnabled('mini-player', true);
    await pluginManager.reconcileWindows(none);
    expect(pluginManager.isEnabled('mini-player')).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    await pluginManager.reconcileWindows(none);
    vi.useRealTimers();
    expect(pluginManager.isEnabled('mini-player')).toBe(false);
  });
});
