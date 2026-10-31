import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/** helpers shared by the always-on-top windows (lyrics overlay, second screen, mini player) */

export type AuxLang = 'en' | 'pl';

export const AUX_STRINGS = {
  en: {
    lyricsIdle: 'Lyrics will appear here',
    lyricsIdleHint: 'Play something in Zenith',
    lyricsNone: 'No lyrics for this track',
    miniIdle: 'Nothing playing',
    close: 'Close',
    drag: 'Drag to move',
    prev: 'Previous',
    next: 'Next',
    play: 'Play',
    pause: 'Pause',
  },
  pl: {
    lyricsIdle: 'Tu pojawi się tekst',
    lyricsIdleHint: 'Włącz coś w Zenith',
    lyricsNone: 'Brak tekstu dla tego utworu',
    miniIdle: 'Nic nie gra',
    close: 'Zamknij',
    drag: 'Przeciągnij, aby przesunąć',
    prev: 'Poprzedni',
    next: 'Następny',
    play: 'Odtwórz',
    pause: 'Pauza',
  },
} as const;

function readLang(): AuxLang {
  try {
    return localStorage.getItem('zenith_lang') === 'pl' ? 'pl' : 'en';
  } catch {
    return 'en';
  }
}

/** same origin as the main window, so the language lives in shared localStorage */
export function useAuxLang(): AuxLang {
  const [lang, setLang] = useState<AuxLang>(readLang);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'zenith_lang') setLang(readLang());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return lang;
}

/** webkitgtk ignores -webkit-app-region, so drag the native window by hand */
export function startWindowDrag(e: ReactMouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, [data-no-drag]')) return;
  e.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch(() => {});
}

export async function closeThisWindow() {
  const win = getCurrentWindow();
  try {
    await invoke('close_window', { label: win.label });
  } catch {
    try {
      await win.destroy();
    } catch {}
  }
}

export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return '';
  }
}
