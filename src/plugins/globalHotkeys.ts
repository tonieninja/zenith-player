import { invoke } from '@tauri-apps/api/core';
import { ZenithPlugin } from './types';

export const HOTKEY_BINDINGS_KEY = 'zenith_global_hotkeys';

export const HOTKEY_ACTIONS = [
  'toggle-play',
  'next',
  'prev',
  'volume-up',
  'volume-down',
  'like',
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];
export type HotkeyBindings = Record<HotkeyAction, string>;

export const DEFAULT_HOTKEYS: HotkeyBindings = {
  'toggle-play': 'Ctrl+Alt+Space',
  next: 'Ctrl+Alt+ArrowRight',
  prev: 'Ctrl+Alt+ArrowLeft',
  'volume-up': '',
  'volume-down': '',
  like: '',
};

export function getHotkeyBindings(): HotkeyBindings {
  const out: HotkeyBindings = { ...DEFAULT_HOTKEYS };
  try {
    const raw = JSON.parse(localStorage.getItem(HOTKEY_BINDINGS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const a of HOTKEY_ACTIONS) if (typeof raw[a] === 'string') out[a] = raw[a];
    }
  } catch (err) {
    console.debug('globalHotkeys getHotkeyBindings', err);
  }
  return out;
}

const CODE_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

export function acceleratorFromEvent(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const code = CODE_NAMES[e.key] ?? e.code;
  if (!code) return null;
  const isFn = /^F\d{1,2}$/.test(code);
  if (!mods.length && !isFn) return null;
  const acc = [...mods, code].join('+');
  const reserved = /^(Ctrl|Cmd|Super|CommandOrControl)\+(Key[CVAQW])$/i;
  if (
    reserved.test(acc) &&
    !acc.toLowerCase().includes('alt') &&
    !acc.toLowerCase().includes('shift')
  ) {
    return null;
  }
  return acc;
}

export function prettyAccelerator(acc: string): string {
  if (!acc) return '';
  return acc
    .split('+')
    .map((p) =>
      p
        .replace(/^Key([A-Z])$/, '$1')
        .replace(/^Digit(\d)$/, '$1')
        .replace(
          /^Arrow(\w+)$/,
          (_m, d: string) => ({ Left: '←', Right: '→', Up: '↑', Down: '↓' })[d] ?? d
        )
    )
    .join(' + ');
}

export async function saveHotkeyBindings(b: HotkeyBindings): Promise<string[]> {
  try {
    localStorage.setItem(HOTKEY_BINDINGS_KEY, JSON.stringify(b));
  } catch (err) {
    console.debug('globalHotkeys saveHotkeyBindings', err);
  }
  return pushHotkeyBindings();
}

export async function pushHotkeyBindings(): Promise<string[]> {
  try {
    return await invoke<string[]>('set_global_hotkey_bindings', { bindings: getHotkeyBindings() });
  } catch {
    return [];
  }
}

export async function syncGlobalHotkeys(enabled: boolean): Promise<number> {
  try {
    return await invoke<number>('set_global_hotkeys', { enabled });
  } catch {
    return 0;
  }
}

export const globalHotkeysPlugin: ZenithPlugin = {
  id: 'global-hotkeys',
  name: 'Global Hotkeys & Media Keys',
  category: 'control',
  description:
    'Play/pause, next, previous, volume and like from any app. Every combo can be changed, media keys always work.',
  defaultEnabled: true,
  onEnable() {
    void syncGlobalHotkeys(true);
  },
  onDisable() {
    void syncGlobalHotkeys(false);
  },
};
