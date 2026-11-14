import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ZenithPlugin } from './types';

async function openSecond() {
  try {
    const existing = await WebviewWindow.getByLabel('lyrics-second');
    if (existing) {
      await existing.show();
      return;
    }
  } catch (err) {
    console.debug('secondScreenLyrics openSecond', err);
  }
  await invoke('open_lyrics_second_screen');
}

async function closeSecond() {
  try {
    await invoke('close_window', { label: 'lyrics-second' });
  } catch {
    try {
      const win = await WebviewWindow.getByLabel('lyrics-second');
      if (win) await win.destroy();
    } catch (err) {
      console.debug('secondScreenLyrics closeSecond', err);
    }
  }
}

export const secondScreenLyricsPlugin: ZenithPlugin = {
  id: 'second-screen-lyrics',
  name: 'Second Screen Lyrics',
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
