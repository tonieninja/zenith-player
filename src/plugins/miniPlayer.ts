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

export type MiniLayout = Record<'play' | 'seek' | 'prev' | 'next', boolean> & { lyrics: boolean };

/** Rozmiar okna z widocznych części: przyciski i pasek dokładają tylko swoje miejsce, tytuł ma stałe 176 px. */
export function miniSize(show: MiniLayout): { w: number; h: number } {
  const btns = [show.prev && 34, show.play && 40, show.next && 34].filter(Boolean) as number[];
  // padding okna 28, okładka z odstępem 68, tytuł 176; sterowanie: przyciski, odstępy 6, margines 14 i odstęp 12
  const controls = btns.length ? btns.reduce((a, b) => a + b, 0) + (btns.length - 1) * 6 + 26 : 0;
  const h = (show.seek ? 96 : 82) + (show.lyrics ? 56 : 0);
  return { w: 28 + 68 + 176 + controls, h };
}
