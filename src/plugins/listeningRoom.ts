/**
 * listening room
 * host talks tauri ipc, rust fans it out on a local websocket
 * guests hit ws://127.0.0.1:{port}/ws?code=XXXXXX
 */
import { invoke } from '@tauri-apps/api/core';
import { ZenithPlugin } from './types';

export interface RoomState {
  trackId: string;
  title: string;
  artist: string;
  coverUrl?: string;
  position: number;
  isPlaying: boolean;
  hostId: string;
  sentAt?: number;
}

export const ROOM_CODE_KEY = 'zenith_room_code';
export const ROOM_ROLE_KEY = 'zenith_room_role';
export const ROOM_PORT_KEY = 'zenith_room_port';

type Role = 'host' | 'guest' | '';

let onSync: ((state: RoomState) => void) | null = null;
let onStatus: ((msg: string) => void) | null = null;
let guestSocket: WebSocket | null = null;

function setRole(role: Role, code: string, port?: number) {
  if (code) localStorage.setItem(ROOM_CODE_KEY, code);
  else localStorage.removeItem(ROOM_CODE_KEY);
  if (role) localStorage.setItem(ROOM_ROLE_KEY, role);
  else localStorage.removeItem(ROOM_ROLE_KEY);
  if (port) localStorage.setItem(ROOM_PORT_KEY, String(port));
  else localStorage.removeItem(ROOM_PORT_KEY);
}

export function registerRoomSyncHandler(fn: (state: RoomState) => void) {
  onSync = fn;
}

export function unregisterRoomSyncHandler() {
  onSync = null;
}

export function registerRoomStatusHandler(fn: (msg: string) => void) {
  onStatus = fn;
}

export function getRoomCode(): string {
  return localStorage.getItem(ROOM_CODE_KEY) || '';
}

export function isRoomHost(): boolean {
  return localStorage.getItem(ROOM_ROLE_KEY) === 'host';
}

export async function createRoom(): Promise<string> {
  await leaveRoom();
  onStatus?.('connecting');
  try {
    const code = await invoke<string>('room_create');
    const port = await invoke<number>('room_get_port');
    setRole('host', code, port);
    onStatus?.('host-ready');
    return code;
  } catch (e) {
    setRole('', '');
    onStatus?.('error');
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export async function joinRoom(code: string): Promise<boolean> {
  const cleaned = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(cleaned)) return false;
  await leaveRoom();
  onStatus?.('connecting');

  try {
    // ask rust for the port, only works on this machine
    // other people use room-guest.html against that port
    const ok = await invoke<boolean>('room_join', { code: cleaned });
    if (!ok) {
      onStatus?.('error');
      return false;
    }
    let port = 18765;
    try {
      port = await invoke<number>('room_get_port');
    } catch {
      port = Number(localStorage.getItem(ROOM_PORT_KEY) || 18765);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?code=${encodeURIComponent(cleaned)}`);
    guestSocket = ws;
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error('ws timeout')), 8000);
      ws.onopen = () => {
        window.clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        window.clearTimeout(t);
        reject(new Error('ws error'));
      };
    });
    ws.onmessage = (ev) => {
      try {
        const state = JSON.parse(String(ev.data)) as RoomState;
        if (state?.trackId != null) onSync?.(state);
      } catch {}
    };
    ws.onclose = () => onStatus?.('peer-left');
    setRole('guest', cleaned, port);
    onStatus?.('joined');
    return true;
  } catch {
    setRole('', '');
    onStatus?.('error');
    return false;
  }
}

export async function leaveRoom() {
  if (guestSocket) {
    try {
      guestSocket.close();
    } catch {}
    guestSocket = null;
  }
  try {
    if (isRoomHost()) await invoke('room_leave');
  } catch {}
  setRole('', '');
  onStatus?.('left');
}

export async function broadcastRoom(state: RoomState) {
  if (!isRoomHost()) return;
  const payload = { ...state, sentAt: Date.now() };
  try {
    await invoke('room_broadcast', {
      state: {
        trackId: payload.trackId,
        title: payload.title,
        artist: payload.artist,
        coverUrl: payload.coverUrl ?? null,
        position: payload.position,
        isPlaying: payload.isPlaying,
        hostId: payload.hostId,
        sentAt: payload.sentAt,
      },
    });
  } catch (err) {
    console.warn('[listening-room] broadcast failed', err);
  }
}

export function roomPeerCount(): number {
  // last snapshot we got, ui refreshes it, dont trust it too much
  // to jest cache z dupy, jak sie rozjedzie to trudno
  return _peerCache;
}

let _peerCache = 0;

export async function refreshRoomPeerCount(): Promise<number> {
  try {
    _peerCache = await invoke<number>('room_peer_count');
  } catch {
    _peerCache = 0;
  }
  return _peerCache;
}

export const listeningRoomPlugin: ZenithPlugin = {
  id: 'listening-room',
  name: 'Listening Room',
  category: 'social',
  description: 'Sync playback with friends over a local WebSocket room (same PC / LAN).',
  defaultEnabled: false,
  async onDisable() {
    unregisterRoomSyncHandler();
    await leaveRoom();
  },
};
