import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../api/youtube';
import { useLatest } from './useLatest';

export type CastDevice = { id: string; name: string; host: string; port: number };

export type CastStatus = {
  session: number;
  conn: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  device: string;
  player: '' | 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
  idle: string;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  error: string;
  // performance.now() w chwili odebrania; pozycję między zgłoszeniami liczymy od niej
  at: number;
};

export type CastOp = 'play' | 'pause' | 'seek' | 'volume' | 'mute';

export function castCmd(op: CastOp, value?: number) {
  void invoke('cast_cmd', { op, value }).catch(() => undefined);
}

export function castPosition(s: CastStatus, now = performance.now()): number {
  const t = s.player === 'PLAYING' ? s.time + (now - s.at) / 1000 : s.time;
  return s.duration > 0 ? Math.min(t, s.duration) : t;
}

export function castLoad(track: Track, start: number, autoplay: boolean) {
  return invoke('cast_load', {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    cover: track.coverLarge || track.cover || null,
    start,
    autoplay,
  });
}

// odbiornik odpowiada na SET_VOLUME starą głośnością, a nową zgłasza po chwili; suwak nie może skakać wstecz
const VOLUME_HOLD_MS = 2000;

export function useCast(onEnd: (error: string) => void) {
  const [status, setStatus] = useState<CastStatus | null>(null);
  const [devices, setDevices] = useState<CastDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  // aktywne od kliknięcia urządzenia do zamknięcia sesji, zanim React przerysuje okno
  const activeRef = useRef(false);
  const holdRef = useRef<{ volume: number; muted: boolean; until: number } | null>(null);
  const onEndRef = useLatest(onEnd);

  useEffect(() => {
    const un = listen<Omit<CastStatus, 'at'>>('cast', ({ payload }) => {
      if (payload.conn === 'closed') {
        if (!activeRef.current) return;
        activeRef.current = false;
        holdRef.current = null;
        setStatus(null);
        onEndRef.current(payload.error);
        return;
      }
      activeRef.current = true;
      const hold = holdRef.current;
      const held = hold && performance.now() < hold.until ? hold : null;
      setStatus({
        ...payload,
        volume: held?.volume ?? payload.volume,
        muted: held?.muted ?? payload.muted,
        at: performance.now(),
      });
    });
    return () => {
      void un.then((f) => f());
    };
  }, [onEndRef]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setDevices(await invoke<CastDevice[]>('cast_discover'));
    } catch {
      setDevices([]);
    } finally {
      setScanning(false);
    }
  }, []);

  const connect = useCallback(async (device: CastDevice) => {
    await invoke<number>('cast_connect', { id: device.id });
    activeRef.current = true;
  }, []);

  const disconnect = useCallback(() => {
    void invoke('cast_disconnect').catch(() => undefined);
  }, []);

  const statusRef = useLatest(status);
  const hold = useCallback((volume: number, muted: boolean) => {
    holdRef.current = { volume, muted, until: performance.now() + VOLUME_HOLD_MS };
    setStatus((s) => (s ? { ...s, volume, muted } : s));
  }, []);

  const setVolume = useCallback(
    (volume: number) => {
      if (statusRef.current?.muted) castCmd('mute', 0);
      hold(volume, false);
      castCmd('volume', volume);
    },
    [hold, statusRef]
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      hold(statusRef.current?.volume ?? 1, muted);
      castCmd('mute', muted ? 1 : 0);
    },
    [hold, statusRef]
  );

  const seek = useCallback((time: number) => {
    setStatus((s) => (s ? { ...s, time, at: performance.now() } : s));
    castCmd('seek', time);
  }, []);

  return {
    status,
    devices,
    scanning,
    activeRef,
    scan,
    connect,
    disconnect,
    setVolume,
    setMuted,
    seek,
  };
}
