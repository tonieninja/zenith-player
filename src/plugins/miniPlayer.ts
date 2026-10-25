import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ZenithPlugin } from './types';

export interface MiniPlayerPayload {
  title: string;
  artist: string;
  trackId?: string;
  coverUrl?: string;
  progress: number;
  rate?: number;
  duration: number;
  isPlaying: boolean;
}

export async function pushMiniPlayerState(payload: MiniPlayerPayload) {
  await emit('zenith-mini-state', payload);
}

async function openMini() {
  try {
    const existing = await WebviewWindow.getByLabel('mini-player');
    if (existing) {
      await existing.show();
      return;
    }
  } catch (e) {
    console.warn('[mini-player] show failed', e);
  }
  await invoke('open_mini_player');
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
  description: 'Compact always-on-top player with cover, progress and transport controls.',
  defaultEnabled: false,
  async onEnable() {
    await openMini();
  },
  async onDisable() {
    await closeMini();
  },
};
