/**
 * dualsense, stolen from dsMediaController
 * touchpad via hid in rust, face buttons fall back to the gamepad api
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NowPlayingInfo, ZenithPlugin } from './types';

export type DualSenseAction = 'toggle-play' | 'next' | 'prev';

type ActionHandler = (action: DualSenseAction) => void;

let actionHandler: ActionHandler | null = null;
let unlistenHid: (() => void) | null = null;
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
  } catch {}
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
  const pads = navigator.getGamepads?.() ?? [];
  let sawPad = false;
  for (const pad of pads) {
    if (!pad) continue;
    const id = (pad.id || '').toLowerCase();
    if (!id.includes('dualsense') && !id.includes('wireless controller') && !id.includes('054c')) {
      continue;
    }
    sawPad = true;
    // cross/A = play, l1 prev, r1 next, dpad is buttons 12-15 or axes, i forget which
    const buttons = pad.buttons.map((b) => (b.pressed ? '1' : '0')).join('');
    if (buttons === lastButtonSnapshot) continue;
    const prev = lastButtonSnapshot;
    lastButtonSnapshot = buttons;

    const pressed = (i: number) => buttons[i] === '1' && prev[i] !== '1';

    if (pressed(0) || pressed(9) || pressed(17)) {
      flashLed(160, 40, 255);
      fire('toggle-play');
    } else if (pressed(5) || pressed(15)) {
      flashLed(0, 220, 80);
      fire('next');
    } else if (pressed(4) || pressed(14)) {
      flashLed(220, 40, 40);
      fire('prev');
    }
  }
  if (!sawPad) lastButtonSnapshot = '';
}

async function startHid() {
  try {
    await invoke('dualsense_start');
  } catch (err) {
    console.warn('[dualsense] HID start failed - gamepad fallback only', err);
  }
  if (unlistenHid) return;
  unlistenHid = await listen<string>('zenith-dualsense-gesture', (e) => {
    const g = e.payload;
    if (g === 'right') {
      flashLed(0, 220, 80);
      fire('next');
    } else if (g === 'left') {
      flashLed(220, 40, 40);
      fire('prev');
    } else if (g === 'up' || g === 'down') {
      flashLed(160, 40, 255);
      fire('toggle-play');
    }
  });
}

async function stopHid() {
  unlistenHid?.();
  unlistenHid = null;
  try {
    await invoke('dualsense_stop');
  } catch {}
  await setLed(0, 0, 0);
}

function startGamepad() {
  if (gamepadRaf) return;
  gamepadRaf = window.setInterval(pollGamepad, 200) as unknown as number;
  const onConnect = () => {
    if (!gamepadRaf) gamepadRaf = window.setInterval(pollGamepad, 100) as unknown as number;
  };
  window.addEventListener('gamepadconnected', onConnect);
  const pads = navigator.getGamepads?.() ?? [];
  if (pads.some((p) => p)) gamepadRaf = window.setInterval(pollGamepad, 100) as unknown as number;
  (startGamepad as unknown as { _onConnect?: () => void })._onConnect = onConnect;
}

function stopGamepad() {
  if (gamepadRaf) window.clearInterval(gamepadRaf);
  gamepadRaf = 0;
  lastButtonSnapshot = '';
  const onConnect = (startGamepad as unknown as { _onConnect?: () => void })._onConnect;
  if (onConnect) window.removeEventListener('gamepadconnected', onConnect);
}

let lastCoverAccent = '';

export const dualSensePlugin: ZenithPlugin = {
  id: 'dualsense-pad',
  name: 'DualSense Pad',
  category: 'utility',
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
