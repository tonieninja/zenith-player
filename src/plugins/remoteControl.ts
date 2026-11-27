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
  | { cmd: 'jump'; index: number; id?: string | null }
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
  sleepLeft: number;
}

export function getRemotePort(): number {
  const n = Number(localStorage.getItem(REMOTE_PORT_KEY));
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
  return REMOTE_DEFAULT_PORT;
}

export function setRemotePort(n: number) {
  localStorage.setItem(REMOTE_PORT_KEY, String(n));
}

export function getRemotePin(): string {
  return localStorage.getItem(REMOTE_PIN_KEY) || '';
}

export function setRemotePin(pin: string) {
  if (pin.trim()) localStorage.setItem(REMOTE_PIN_KEY, pin.trim().slice(0, 32));
  else localStorage.removeItem(REMOTE_PIN_KEY);
}

export function getRemotePairMode(): boolean {
  return localStorage.getItem(REMOTE_PAIR_KEY) !== '0';
}

export function setRemotePairMode(on: boolean) {
  if (on) localStorage.setItem(REMOTE_PAIR_KEY, '1');
  else localStorage.setItem(REMOTE_PAIR_KEY, '0');
}

export async function forgetRemoteDevices(): Promise<RemoteInfo | null> {
  try {
    return await invoke<RemoteInfo>('remote_forget_devices');
  } catch {
    return null;
  }
}

let lastLyricsKey = '';
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
  void invoke('remote_push', { payload });
}

let listening: Promise<UnlistenFn> | null = null;
let savedHandler: ((c: RemoteCommand) => void) | null = null;
let running = false;
let lastPayload = '';
let stops = 0;
let starts = 0;

export async function startRemote(handler: (c: RemoteCommand) => void): Promise<RemoteInfo> {
  savedHandler = handler;
  const stopsAtStart = stops;
  const me = ++starts;
  // jedna obietnica nasłuchu: dwa szybkie starty rejestrowały dwa nasłuchy i każda komenda szła dwa razy
  listening ??= listen<RemoteCommand>('zenith-remote-cmd', (e) => savedHandler?.(e.payload));
  await listening;
  const info = await invoke<RemoteInfo>('remote_start', {
    port: getRemotePort(),
    pin: getRemotePin(),
    pair: getRemotePairMode(),
  });
  // wyłączenie w trakcie startu wygrywa, chyba że po nim ruszył nowszy start, do którego serwer już należy
  if (stops !== stopsAtStart) {
    if (starts === me) await invoke('remote_stop');
    return info;
  }
  running = true;
  lastPayload = '';
  lastLyricsKey = '';
  return info;
}

export async function restartRemote(): Promise<RemoteInfo | null> {
  if (!savedHandler) return null;
  return startRemote(savedHandler);
}

export async function stopRemote() {
  stops += 1;
  running = false;
  lastPayload = '';
  window.clearTimeout(pushTimer);
  pushTimer = 0;
  const l = listening;
  listening = null;
  void l?.then((off) => off());
  await invoke('remote_stop');
}

export async function getRemoteInfo(): Promise<RemoteInfo | null> {
  try {
    return await invoke<RemoteInfo>('remote_info');
  } catch {
    return null;
  }
}

export function pushRemoteState(s: RemoteState) {
  if (!running) return;
  const payload = JSON.stringify({ type: 'state', ...s });
  if (payload === lastPayload) return;
  lastPayload = payload;
  void invoke('remote_push', { payload });
}

export function pushRemoteMessage(msg: Record<string, unknown>) {
  if (!running) return;
  void invoke('remote_push', { payload: JSON.stringify(msg) });
}

let pusher: (() => void) | null = null;
let pushTimer = 0;
let lastDuration = -1;
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
  name: 'Phone remote',
  category: 'control',
  description:
    'Control Zenith from your phone or any device on your network: volume, play/pause, skip, seek, queue, like and search in a browser.',
  defaultEnabled: false,
  onTrackChange: schedulePush,
  onPlayStateChange: schedulePush,
  onSeek: schedulePush,
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
  blocked: boolean;
}

export async function getFirewallStatus(): Promise<FirewallStatus | null> {
  try {
    return await invoke<FirewallStatus>('remote_firewall_status');
  } catch {
    return null;
  }
}

// publicNetwork = true otwiera pilota także w sieci publicznej, więc tylko po kliknięciu pod tym ostrzeżeniem
export async function allowThroughFirewall(publicNetwork: boolean): Promise<boolean> {
  try {
    return await invoke<boolean>('remote_firewall_allow', { publicNetwork });
  } catch {
    return false;
  }
}
