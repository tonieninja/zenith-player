import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { storedFlag, type StoredFlag } from '../lyrics/flag';
import { ZenithPlugin } from './types';

// tekst pod sterowaniem; przełącznik działa z mini okna i z ustawień wtyczki
export const miniLyrics = storedFlag('zenith_mini_lyrics');

export const MINI_PARTS = ['play', 'seek', 'like', 'prev', 'next'] as const;
export type MiniPart = (typeof MINI_PARTS)[number];

// zapisujemy ukrycie, więc brak wpisu (np. nowa instalacja) znaczy, że element jest widoczny
export const miniHidden = Object.fromEntries(
  MINI_PARTS.map((p) => [p, storedFlag(`zenith_mini_hide_${p}`)])
) as Record<MiniPart, StoredFlag>;

export interface MiniPlayerPayload {
  title: string;
  artist: string;
  trackId?: string;
  coverUrl?: string;
  progress: number;
  rate?: number;
  duration: number;
  isPlaying: boolean;
  liked?: boolean;
}

export async function pushMiniPlayerState(payload: MiniPlayerPayload) {
  await emit('zenith-mini-state', payload);
}

async function openMini() {
  const existing = await WebviewWindow.getByLabel('mini-player').catch(() => null);
  const shown = await existing?.show().then(
    () => true,
    () => false
  );
  if (!shown) await invoke('open_mini_player');
}

async function closeMini() {
  try {
    await invoke('close_window', { label: 'mini-player' });
  } catch {
    const win = await WebviewWindow.getByLabel('mini-player');
    if (win) await win.destroy();
  }
}

export const miniPlayerPlugin: ZenithPlugin = {
  id: 'mini-player',
  name: 'Mini player',
  category: 'interface',
  description:
    'Compact always-on-top player with cover, a seekable timeline, like button and optional synced lyrics.',
  defaultEnabled: false,
  async onEnable() {
    await openMini();
  },
  async onDisable() {
    await closeMini();
  },
};
