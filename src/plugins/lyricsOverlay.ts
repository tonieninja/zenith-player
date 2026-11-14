import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { OverlayPayload } from '../overlay/types';
import { ZenithPlugin } from './types';

export const HIGH_CONTRAST_KEY = 'zenith_lyrics_high_contrast';

export function isHighContrastLyrics(): boolean {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) !== '0';
  } catch (err) {
    console.debug('lyricsOverlay isHighContrastLyrics', err);
  }
  return true;
}

export function setHighContrastLyrics(on: boolean) {
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, on ? '1' : '0');
  } catch (err) {
    console.debug('lyricsOverlay setHighContrastLyrics', err);
  }
}

export const OVERLAY_FONT_KEY = 'zenith_overlay_font';
export const OVERLAY_ALIGN_KEY = 'zenith_overlay_align';
export const OVERLAY_OPACITY_KEY = 'zenith_overlay_opacity';
export const OVERLAY_HIDE_META_KEY = 'zenith_overlay_hide_meta';
export const LYRICS_SYNC_OFFSET_KEY = 'zenith_lyrics_sync_offset_ms';

export const LYRICS_SYNC_OFFSET_MIN = -3000;
export const LYRICS_SYNC_OFFSET_MAX = 3000;
export const LYRICS_SYNC_OFFSET_STEP = 50;

export function getLyricsSyncOffset(): number {
  try {
    const v = Number(localStorage.getItem(LYRICS_SYNC_OFFSET_KEY));
    if (Number.isFinite(v)) {
      return Math.max(LYRICS_SYNC_OFFSET_MIN, Math.min(LYRICS_SYNC_OFFSET_MAX, v));
    }
  } catch (err) {
    console.debug('lyricsOverlay getLyricsSyncOffset', err);
  }
  return 0;
}

export function setLyricsSyncOffset(ms: number) {
  const clamped = Math.max(LYRICS_SYNC_OFFSET_MIN, Math.min(LYRICS_SYNC_OFFSET_MAX, ms));
  try {
    localStorage.setItem(LYRICS_SYNC_OFFSET_KEY, String(clamped));
  } catch (err) {
    console.debug('lyricsOverlay setLyricsSyncOffset', err);
  }
  window.dispatchEvent(new CustomEvent('zenith-lyrics-sync-changed', { detail: clamped }));
  notifySettingsChanged();
}

export const OVERLAY_SETTINGS_EVENT = 'zenith-overlay-settings-changed';

function notifySettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(OVERLAY_SETTINGS_EVENT));
  } catch (err) {
    console.debug('lyricsOverlay notifySettingsChanged', err);
  }
}

export type OverlayFontSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

export function getOverlayFontSize(): OverlayFontSize {
  try {
    const v = localStorage.getItem(OVERLAY_FONT_KEY);
    if (v === 'sm' || v === 'md' || v === 'lg' || v === 'xl' || v === 'auto') return v;
  } catch (err) {
    console.debug('lyricsOverlay getOverlayFontSize', err);
  }
  return 'auto';
}

export function setOverlayFontSize(size: OverlayFontSize) {
  try {
    localStorage.setItem(OVERLAY_FONT_KEY, size);
  } catch (err) {
    console.debug('lyricsOverlay setOverlayFontSize', err);
  }
  notifySettingsChanged();
}

export function getOverlayAlign(): 'bottom' | 'top' | 'center' {
  try {
    const v = localStorage.getItem(OVERLAY_ALIGN_KEY);
    if (v === 'top' || v === 'center') return v;
  } catch (err) {
    console.debug('lyricsOverlay getOverlayAlign', err);
  }
  return 'bottom';
}

export function setOverlayAlign(align: 'bottom' | 'top' | 'center') {
  try {
    localStorage.setItem(OVERLAY_ALIGN_KEY, align);
  } catch (err) {
    console.debug('lyricsOverlay setOverlayAlign', err);
  }
  notifySettingsChanged();
}

export function getOverlayOpacity(): number {
  try {
    const v = Number(localStorage.getItem(OVERLAY_OPACITY_KEY));
    if (Number.isFinite(v) && v >= 0.4 && v <= 0.98) return v;
  } catch (err) {
    console.debug('lyricsOverlay getOverlayOpacity', err);
  }
  return 0.88;
}

export function setOverlayOpacity(opacity: number) {
  try {
    localStorage.setItem(OVERLAY_OPACITY_KEY, String(opacity));
  } catch (err) {
    console.debug('lyricsOverlay setOverlayOpacity', err);
  }
  notifySettingsChanged();
}

export function getOverlayHideMeta(): boolean {
  try {
    return localStorage.getItem(OVERLAY_HIDE_META_KEY) === '1';
  } catch (err) {
    console.debug('lyricsOverlay getOverlayHideMeta', err);
  }
  return false;
}

export function setOverlayHideMeta(hide: boolean) {
  try {
    localStorage.setItem(OVERLAY_HIDE_META_KEY, hide ? '1' : '0');
  } catch (err) {
    console.debug('lyricsOverlay setOverlayHideMeta', err);
  }
  notifySettingsChanged();
}

async function openOverlayWindow() {
  try {
    const existing = await WebviewWindow.getByLabel('lyrics-overlay');
    if (existing) {
      await existing.show();
      return;
    }
  } catch (err) {
    console.debug('lyricsOverlay openOverlayWindow', err);
  }
  await invoke('open_lyrics_overlay');
}

async function closeOverlayWindow() {
  try {
    await invoke('close_window', { label: 'lyrics-overlay' });
  } catch {
    try {
      const win = await WebviewWindow.getByLabel('lyrics-overlay');
      if (win) await win.destroy();
    } catch (err) {
      console.debug('lyricsOverlay closeOverlayWindow', err);
    }
  }
}

let lastOverlaySig = '';

export async function pushLyricsOverlay(
  payload: Omit<
    OverlayPayload,
    'fontSize' | 'align' | 'opacity' | 'highContrast' | 'secondScreen' | 'hideTrackMeta'
  >,
  opts?: { secondScreen?: boolean; force?: boolean }
) {
  const sig = [
    payload.title,
    payload.artist,
    payload.coverUrl ?? '',
    payload.synced?.length ?? 0,
    payload.activeLyricIndex ?? -1,
    payload.isPlaying ? 1 : 0,
    payload.text?.length ?? 0,
    Math.floor(payload.progress || 0),
  ].join('|');
  if (!opts?.force && sig === lastOverlaySig) return;
  lastOverlaySig = sig;

  const full: OverlayPayload = {
    ...payload,
    fontSize: getOverlayFontSize(),
    align: getOverlayAlign(),
    opacity: getOverlayOpacity(),
    highContrast: isHighContrastLyrics(),
    secondScreen: false,
    hideTrackMeta: getOverlayHideMeta(),
    syncOffsetMs: getLyricsSyncOffset(),
  };
  try {
    await emitTo('lyrics-overlay', 'zenith-lyrics-overlay', full);
    if (opts?.secondScreen) {
      await emitTo('lyrics-second', 'zenith-lyrics-overlay', {
        ...full,
        secondScreen: true,
        align: 'center',
      });
    }
  } catch (err) {
    console.debug('lyricsOverlay pushLyricsOverlay', err);
  }
}

export const lyricsOverlayPlugin: ZenithPlugin = {
  id: 'lyrics-overlay',
  name: 'Lyrics Overlay',
  category: 'lyrics',
  description: 'Always-on-top transparent overlay with synced lyrics and automatic font size.',
  defaultEnabled: false,
  async onEnable() {
    await openOverlayWindow();
  },
  async onDisable() {
    await closeOverlayWindow();
  },
};
