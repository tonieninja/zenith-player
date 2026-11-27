import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { refreshCoverTheme } from './coverTheme';
import { applyTheme, isLightTheme } from './themes';

export type Appearance = 'dark' | 'light' | 'system';

// ten sam klucz czyta public/theme-boot.js przed pierwszym malowaniem i Rust przy starcie okna
const KEY = 'zenith_appearance';
const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)');
// kolory liczone w JS (np. z okładki) trzeba przeliczyć po zmianie motywu
const EVENT = 'zenith-appearance';

const subscribe = (f: () => void) => {
  window.addEventListener(EVENT, f);
  return () => window.removeEventListener(EVENT, f);
};
export const useLightTheme = () => useSyncExternalStore(subscribe, isLightTheme);

export function currentAppearance(): Appearance {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}

let watching = false;

export function applyAppearance(mode?: Appearance) {
  if (mode) localStorage.setItem(KEY, mode);
  const m = mode ?? currentAppearance();
  const light = m === 'light' || (m === 'system' && !!systemLight()?.matches);
  const root = document.documentElement;
  // pierwsze wywołanie zawsze wyrównuje tło okna, bo prefs.json czytany przez Rust mógł być starszy
  const changed = !watching || (root.dataset.theme === 'light') !== light;
  if (light) root.dataset.theme = 'light';
  else delete root.dataset.theme;
  if (!watching) {
    watching = true;
    systemLight()?.addEventListener('change', () => {
      if (currentAppearance() === 'system') applyAppearance();
    });
    // mini odtwarzacz to osobne okno, więc zmianę ustawienia dostaje przez zdarzenie storage
    window.addEventListener('storage', (e) => {
      if (e.key === KEY) applyAppearance();
    });
  }
  if (!changed) return;
  applyTheme();
  refreshCoverTheme();
  window.dispatchEvent(new Event(EVENT));
  // tło okna widać przy zmianie rozmiaru i zanim WebView narysuje stronę
  void invoke('set_window_light', { light }).catch(() => undefined);
}
