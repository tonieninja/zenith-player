import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ZenithPlugin } from './types';

async function openSecond() {
  const existing = await WebviewWindow.getByLabel('lyrics-second').catch(() => null);
  const shown = await existing?.show().then(
    () => true,
    () => false
  );
  if (!shown) await invoke('open_lyrics_second_screen');
}

async function closeSecond() {
  try {
    await invoke('close_window', { label: 'lyrics-second' });
  } catch {
    const win = await WebviewWindow.getByLabel('lyrics-second');
    if (win) await win.destroy();
  }
}

export const secondScreenLyricsPlugin: ZenithPlugin = {
  id: 'second-screen-lyrics',
  name: 'Second screen lyrics',
  category: 'lyrics',
  description: 'Fullscreen lyrics on your second monitor with large, centered text.',
  defaultEnabled: false,
  async onEnable() {
    await openSecond();
  },
  async onDisable() {
    await closeSecond();
  },
};
