export type KeyboardAction =
  | 'toggle-play'
  | 'next'
  | 'prev'
  | 'seek-forward'
  | 'seek-back'
  | 'volume-up'
  | 'volume-down'
  | 'mute';

export interface KeyboardHandler {
  (action: KeyboardAction): void;
}

let handler: KeyboardHandler | null = null;

export function registerKeyboardHandler(h: KeyboardHandler) {
  handler = h;
}

export function setupKeyboardShortcuts(enabled: boolean) {
  const onKey = (e: KeyboardEvent) => {
    if (!enabled || !handler) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (e.target as HTMLElement)?.isContentEditable
    )
      return;
    if (e.defaultPrevented || (e.repeat && e.code === 'Space')) return;
    // ctrl/cmd+letter combos belong to the app (Ctrl+F search) or the system
    const letterCombo = (e.ctrlKey || e.metaKey || e.altKey) && e.code.startsWith('Key');
    if (letterCombo) return;

    if (e.code === 'Space') {
      e.preventDefault();
      handler('toggle-play');
    } else if (e.code === 'ArrowRight' && e.shiftKey) {
      e.preventDefault();
      handler('seek-forward');
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
      e.preventDefault();
      handler('seek-back');
    } else if (e.code === 'ArrowRight') {
      handler('next');
    } else if (e.code === 'ArrowLeft') {
      handler('prev');
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      handler('volume-up');
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      handler('volume-down');
    } else if (e.code === 'KeyM') {
      handler('mute');
    } else if (e.code === 'KeyN' && !e.shiftKey) {
      handler('next');
    } else if (e.code === 'KeyP' && !e.shiftKey) {
      handler('prev');
    }
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

import { ZenithPlugin } from './types';

export const keyboardShortcutsPlugin: ZenithPlugin = {
  id: 'keyboard-shortcuts',
  name: 'Keyboard Shortcuts',
  category: 'control',
  description:
    'Space = play/pause, ←/→ or P/N = prev/next, Shift+←/→ = seek ±10s, ↑/↓ = volume, M = mute, Ctrl+F or / = search.',
  defaultEnabled: true,
};
