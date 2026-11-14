import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NowPlayingInfo, ZenithPlugin } from './types';

export type DualSenseAction = 'toggle-play' | 'next' | 'prev';

type ActionHandler = (action: DualSenseAction) => void;

let actionHandler: ActionHandler | null = null;
let unlistenHid: (() => void) | null = null;
let unlistenStatus: (() => void) | null = null;
let hidConnected = false;
let gamepadRaf = 0;
let lastButtonSnapshot = '';
let lastGestureAt = 0;

const DEBOUNCE_MS = 450;

export function registerDualSenseHandler(fn: ActionHandler) {
  actionHandler = fn;
}

function fire(action: DualSenseAction) {
  const now = performance.now();
  if (now - lastGestureAt < DEBOUNCE_MS) return;
  lastGestureAt = now;
  actionHandler?.(action);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function setLed(r: number, g: number, b: number) {
  try {
    await invoke('dualsense_set_led', { r, g, b });
  } catch (err) {
    console.debug('dualSense setLed', err);
  }
}

async function setLedPlaying(playing: boolean, coverAccent?: string) {
  if (!playing) {
    await setLed(0, 0, 0);
    return;
  }
  const rgb = coverAccent ? hexToRgb(coverAccent) : null;
  if (rgb) await setLed(rgb[0], rgb[1], rgb[2]);
  else await setLed(0, 90, 255);
}

function flashLed(r: number, g: number, b: number) {
  void (async () => {
    await setLed(r, g, b);
    await new Promise((res) => setTimeout(res, 350));
  })();
}

function pollGamepad() {
  // przyciski czyta już Rust z HID, Gamepad API zostaje na wypadek braku dostępu do HID
  if (hidConnected) return;
  const pads = navigator.getGamepads?.() ?? [];
  let sawPad = false;
  for (const pad of pads) {
    if (!pad) continue;
    const id = (pad.id || '').toLowerCase();
    if (!id.includes('dualsense') && !id.includes('wireless controller') && !id.includes('054c')) {
      continue;
    }
    sawPad = true;
    const buttons = pad.buttons.map((b) => (b.pressed ? '1' : '0')).join('');
    if (buttons === lastButtonSnapshot) continue;
    const prev = lastButtonSnapshot;
    lastButtonSnapshot = buttons;

    const pressed = (i: number) => buttons[i] === '1' && prev[i] !== '1';

    const action: DualSenseAction | null =
      pressed(0) || pressed(9) || pressed(17)
        ? 'toggle-play'
        : pressed(5) || pressed(15)
          ? 'next'
          : pressed(4) || pressed(14)
            ? 'prev'
            : null;
    if (action) {
      flashFor(action);
      fire(action);
    }
  }
  if (!sawPad) lastButtonSnapshot = '';
}

let hidGen = 0;

function flashFor(action: string) {
  if (action === 'next') flashLed(0, 220, 80);
  else if (action === 'prev') flashLed(220, 40, 40);
  else flashLed(160, 40, 255);
}

async function startHid() {
  const gen = ++hidGen;
  if (!unlistenStatus) {
    const un = await listen<string>('zenith-dualsense-status', (e) => {
      hidConnected = e.payload === 'connected' || e.payload === 'connected-bt';
    });
    if (gen !== hidGen || unlistenStatus) un();
    else unlistenStatus = un;
  }
  try {
    await invoke('dualsense_start');
  } catch (err) {
    console.warn('[dualsense] HID start failed - gamepad fallback only', err);
  }
  if (gen !== hidGen) {
    invoke('dualsense_stop').catch((err) => console.debug('dualSense startHid', err));
    return;
  }
  if (unlistenHid) return;
  const un = await listen<string>('zenith-dualsense-action', (e) => {
    const a = e.payload;
    if (a !== 'next' && a !== 'prev' && a !== 'toggle-play') return;
    flashFor(a);
    fire(a);
  });
  if (gen !== hidGen || unlistenHid) {
    un();
    return;
  }
  unlistenHid = un;
}

async function stopHid() {
  hidGen += 1;
  unlistenHid?.();
  unlistenHid = null;
  unlistenStatus?.();
  unlistenStatus = null;
  hidConnected = false;
  try {
    await invoke('dualsense_stop');
  } catch (err) {
    console.debug('dualSense stopHid', err);
  }
  await setLed(0, 0, 0);
}

let onGamepadConnect: (() => void) | null = null;

function startGamepad() {
  if (gamepadRaf) return;
  const pads = navigator.getGamepads?.() ?? [];
  const fast = pads.some((p) => p);
  gamepadRaf = window.setInterval(pollGamepad, fast ? 100 : 200) as unknown as number;
  onGamepadConnect = () => {
    if (!gamepadRaf) return;
    window.clearInterval(gamepadRaf);
    gamepadRaf = window.setInterval(pollGamepad, 100) as unknown as number;
  };
  window.addEventListener('gamepadconnected', onGamepadConnect);
}

function stopGamepad() {
  if (gamepadRaf) window.clearInterval(gamepadRaf);
  gamepadRaf = 0;
  lastButtonSnapshot = '';
  if (onGamepadConnect) window.removeEventListener('gamepadconnected', onGamepadConnect);
  onGamepadConnect = null;
}

let lastCoverAccent = '';

export const dualSensePlugin: ZenithPlugin = {
  id: 'dualsense-pad',
  name: 'DualSense Pad',
  category: 'control',
  description:
    'Control Zenith with a DualSense: touchpad swipe (next/prev/play) + face buttons. LED follows cover art while playing.',
  defaultEnabled: false,
  async onEnable() {
    await startHid();
    startGamepad();
  },
  async onDisable() {
    stopGamepad();
    await stopHid();
  },
  onPlayStateChange(isPlaying) {
    void setLedPlaying(isPlaying, lastCoverAccent);
  },
  onNowPlaying(info: NowPlayingInfo | null) {
    try {
      lastCoverAccent =
        getComputedStyle(document.documentElement).getPropertyValue('--theme-accent').trim() || '';
    } catch {
      lastCoverAccent = '';
    }
    void setLedPlaying(Boolean(info?.isPlaying), lastCoverAccent);
  },
};
