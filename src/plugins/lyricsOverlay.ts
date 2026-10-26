import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { OverlayPayload } from '../overlay/types';
import { ZenithPlugin } from './types';

export const HIGH_CONTRAST_KEY = 'zenith_lyrics_high_contrast';

export function isHighContrastLyrics(): boolean {
  return localStorage.getItem(HIGH_CONTRAST_KEY) !== '0';
}

export function setHighContrastLyrics(on: boolean) {
  localStorage.setItem(HIGH_CONTRAST_KEY, on ? '1' : '0');
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
  const v = Number(localStorage.getItem(LYRICS_SYNC_OFFSET_KEY));
  if (Number.isFinite(v)) {
    return Math.max(LYRICS_SYNC_OFFSET_MIN, Math.min(LYRICS_SYNC_OFFSET_MAX, v));
  }
  return 0;
}

export function setLyricsSyncOffset(ms: number) {
  const clamped = Math.max(LYRICS_SYNC_OFFSET_MIN, Math.min(LYRICS_SYNC_OFFSET_MAX, ms));
  localStorage.setItem(LYRICS_SYNC_OFFSET_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent('zenith-lyrics-sync-changed', { detail: clamped }));
  notifySettingsChanged();
}

export const OVERLAY_SETTINGS_EVENT = 'zenith-overlay-settings-changed';

function notifySettingsChanged() {
  window.dispatchEvent(new CustomEvent(OVERLAY_SETTINGS_EVENT));
}

export type OverlayFontSize = 'sm' | 'md' | 'lg' | 'xl' | 'auto';

export function getOverlayFontSize(): OverlayFontSize {
  const v = localStorage.getItem(OVERLAY_FONT_KEY);
  if (v === 'sm' || v === 'md' || v === 'lg' || v === 'xl' || v === 'auto') return v;
  return 'auto';
}

export function setOverlayFontSize(size: OverlayFontSize) {
  localStorage.setItem(OVERLAY_FONT_KEY, size);
  notifySettingsChanged();
}

export function getOverlayAlign(): 'bottom' | 'top' | 'center' {
  const v = localStorage.getItem(OVERLAY_ALIGN_KEY);
  if (v === 'top' || v === 'center') return v;
  return 'bottom';
}

export function setOverlayAlign(align: 'bottom' | 'top' | 'center') {
  localStorage.setItem(OVERLAY_ALIGN_KEY, align);
  notifySettingsChanged();
}

export function getOverlayOpacity(): number {
  const v = Number(localStorage.getItem(OVERLAY_OPACITY_KEY));
  if (Number.isFinite(v) && v >= 0.4 && v <= 0.98) return v;
  return 0.88;
}

export function setOverlayOpacity(opacity: number) {
  localStorage.setItem(OVERLAY_OPACITY_KEY, String(opacity));
  notifySettingsChanged();
}

export function getOverlayHideMeta(): boolean {
  return localStorage.getItem(OVERLAY_HIDE_META_KEY) === '1';
}

export function setOverlayHideMeta(hide: boolean) {
  localStorage.setItem(OVERLAY_HIDE_META_KEY, hide ? '1' : '0');
  notifySettingsChanged();
}

export const SECOND_HIDE_META_KEY = 'zenith_second_hide_meta';

export function getSecondScreenHideMeta(): boolean {
  return localStorage.getItem(SECOND_HIDE_META_KEY) === '1';
}

export function setSecondScreenHideMeta(hide: boolean) {
  localStorage.setItem(SECOND_HIDE_META_KEY, hide ? '1' : '0');
  notifySettingsChanged();
}

async function openOverlayWindow() {
  const existing = await WebviewWindow.getByLabel('lyrics-overlay').catch(() => null);
  const shown = await existing?.show().then(
    () => true,
    () => false
  );
  if (!shown) await invoke('open_lyrics_overlay');
}

async function closeOverlayWindow() {
  try {
    await invoke('close_window', { label: 'lyrics-overlay' });
  } catch {
    const win = await WebviewWindow.getByLabel('lyrics-overlay');
    if (win) await win.destroy();
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
        hideTrackMeta: getSecondScreenHideMeta(),
      });
    }
  } catch {
    lastOverlaySig = '';
  }
}

export const lyricsOverlayPlugin: ZenithPlugin = {
  id: 'lyrics-overlay',
  name: 'Lyrics overlay',
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
