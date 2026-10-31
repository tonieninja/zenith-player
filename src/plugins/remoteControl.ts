/**
 * Control by your internet: phone / tablet / any browser in the same network drives
 * Zenith through a tiny server in Rust (src-tauri/src/remote.rs). The server only
 * exists while this plugin is on; state is pushed on change, never polled.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ZenithPlugin } from './types';

export const REMOTE_PORT_KEY = 'zenith_remote_port';
export const REMOTE_PIN_KEY = 'zenith_remote_pin';
export const REMOTE_PAIR_KEY = 'zenith_remote_pair';
export const REMOTE_DEFAULT_PORT = 8765;

export interface RemoteInfo {
  running: boolean;
  port: number;
  url?: string | null;
  mdnsUrl?: string | null;
  qrUrl?: string | null;
  qrSvg?: string | null;
  clients: number;
  pairedDevices: number;
}

export interface RemoteTrack {
  id: string;
  title: string;
  artist: string;
  cover: string;
}

export type RemoteCommand =
  | { cmd: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'like' | 'mute' | 'shuffle' | 'loop' }
  | { cmd: 'volume' | 'seek'; value: number }
  | { cmd: 'jump'; index: number }
  | { cmd: 'sleep'; minutes: number }
  | { cmd: 'search'; query: string; req: number }
  | { cmd: 'playTrack' | 'addTrack' | 'playNextTrack'; track: RemoteTrack };

export interface RemoteState {
  track: RemoteTrack | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  liked: boolean;
  shuffle: boolean;
  queue: RemoteTrack[];
  queueOffset: number;
  queueIndex: number;
  /** seconds until the sleep timer stops playback, 0 = off */
  sleepLeft: number;
}

export function getRemotePort(): number {
  try {
    const n = Number(localStorage.getItem(REMOTE_PORT_KEY));
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
  } catch {}
  return REMOTE_DEFAULT_PORT;
}

export function setRemotePort(n: number) {
  try {
    localStorage.setItem(REMOTE_PORT_KEY, String(n));
  } catch {}
}

export function getRemotePin(): string {
  try {
    return localStorage.getItem(REMOTE_PIN_KEY) || '';
  } catch {}
  return '';
}

export function setRemotePin(pin: string) {
  try {
    if (pin.trim()) localStorage.setItem(REMOTE_PIN_KEY, pin.trim().slice(0, 32));
    else localStorage.removeItem(REMOTE_PIN_KEY);
  } catch {}
}

/** one-time QR link mode: phones pair by scanning, no PIN typing */
export function getRemotePairMode(): boolean {
  try {
    // pairing (QR code, one key per device) is the default: with no PIN and no pairing
    // anyone on the same network (a school or dorm wifi) could control the player
    return localStorage.getItem(REMOTE_PAIR_KEY) !== '0';
  } catch {}
  return false;
}

export function setRemotePairMode(on: boolean) {
  try {
    if (on) localStorage.setItem(REMOTE_PAIR_KEY, '1');
    else localStorage.setItem(REMOTE_PAIR_KEY, '0');
  } catch {}
}

export async function forgetRemoteDevices(): Promise<RemoteInfo | null> {
  try {
    return await invoke<RemoteInfo>('remote_forget_devices');
  } catch {
    return null;
  }
}

let lastLyricsKey = '';
/** current lyrics for the phone's Lyrics tab; sent once per track / provider change */
export function pushRemoteLyrics(
  trackId: string | null,
  synced: { time: number; text: string }[] | undefined,
  plain: string | null | undefined
) {
  if (!running) return;
  const key = `${trackId}|${synced?.length ?? 0}|${plain?.length ?? 0}|${synced?.[0]?.text ?? ''}`;
  if (key === lastLyricsKey) return;
  lastLyricsKey = key;
  const payload = JSON.stringify({
    type: 'lyrics',
    trackId,
    synced: (synced || [])
      .slice(0, 400)
      .map((l) => ({ t: Math.round(l.time * 100) / 100, x: l.text })),
    plain: synced?.length ? null : (plain || '').slice(0, 20000),
  });
  invoke('remote_push', { payload }).catch(() => {});
}

let unlisten: UnlistenFn | null = null;
let savedHandler: ((c: RemoteCommand) => void) | null = null;
let running = false;
let lastPayload = '';

/** starts (or re-keys) the server and routes phone commands to `handler` */
export async function startRemote(handler: (c: RemoteCommand) => void): Promise<RemoteInfo> {
  savedHandler = handler;
  if (!unlisten) {
    unlisten = await listen<RemoteCommand>('zenith-remote-cmd', (e) => savedHandler?.(e.payload));
  }
  const info = await invoke<RemoteInfo>('remote_start', {
    port: getRemotePort(),
    pin: getRemotePin(),
    pair: getRemotePairMode(),
  });
  running = true;
  lastPayload = '';
  lastLyricsKey = '';
  return info;
}

/** settings changed (port / PIN): rebind with the handler App registered */
export async function restartRemote(): Promise<RemoteInfo | null> {
  if (!savedHandler) return null;
  return startRemote(savedHandler);
}

export async function stopRemote() {
  running = false;
  lastPayload = '';
  unlisten?.();
  unlisten = null;
  try {
    await invoke('remote_stop');
  } catch {}
}

export function remoteRunning() {
  return running;
}

export async function getRemoteInfo(): Promise<RemoteInfo | null> {
  try {
    return await invoke<RemoteInfo>('remote_info');
  } catch {
    return null;
  }
}

/** pushes only when something a phone can see changed (position is sent as a
 * timestamped anchor; the page interpolates, so no per-tick traffic) */
export function pushRemoteState(s: RemoteState) {
  if (!running) return;
  const payload = JSON.stringify({ type: 'state', ...s });
  if (payload === lastPayload) return;
  lastPayload = payload;
  invoke('remote_push', { payload }).catch(() => {});
}

export function pushRemoteMessage(msg: Record<string, unknown>) {
  if (!running) return;
  invoke('remote_push', { payload: JSON.stringify(msg) }).catch(() => {});
}

let pusher: (() => void) | null = null;
let pushTimer = 0;
let lastDuration = -1;
/** App gives us a "send a fresh snapshot" callback; hooks below coalesce into it */
export function registerRemotePusher(fn: (() => void) | null) {
  pusher = fn;
}
function schedulePush() {
  if (!running || !pusher || pushTimer) return;
  pushTimer = window.setTimeout(() => {
    pushTimer = 0;
    pusher?.();
  }, 60);
}

export const remoteControlPlugin: ZenithPlugin = {
  id: 'remote-control',
  name: 'Control by your internet',
  category: 'control',
  description:
    'Control Zenith from your phone or any device on your network: volume, play/pause, skip, seek, queue, like and search in a browser.',
  defaultEnabled: false,
  onTrackChange: schedulePush,
  onPlayStateChange: schedulePush,
  onSeek: schedulePush,
  // only reacts when the duration becomes known / changes, not on every tick
  onNowPlaying(info) {
    const d = info ? Math.round(info.duration) : 0;
    if (d === lastDuration) return;
    lastDuration = d;
    schedulePush();
  },
  onDisable() {
    void stopRemote();
  },
};

export interface FirewallStatus {
  windows: boolean;
  ruleOk: boolean;
  publicNetwork: boolean;
}

/** windows only: does our inbound rule exist (phones get silently dropped without it) */
export async function getFirewallStatus(): Promise<FirewallStatus | null> {
  try {
    return await invoke<FirewallStatus>('remote_firewall_status');
  } catch {
    return null;
  }
}

/** one UAC prompt, adds the local-network rule; true when the rule is in place afterwards */
export async function allowThroughFirewall(): Promise<boolean> {
  try {
    return await invoke<boolean>('remote_firewall_allow');
  } catch {
    return false;
  }
}
