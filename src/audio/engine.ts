import { invoke } from '@tauri-apps/api/core';
import { DualAudio } from './dualAudio';
import { NativeAudio, type EngineSnapshot } from './nativeAudio';
import type { Track } from '../api/youtube';
import type { ListenHandoff, Scrobble } from '../plugins/scrobbler';

export type PlayerAudio = DualAudio | NativeAudio;

export interface HeadlessPlan {
  queue: Track[];
  index: number;
  loopMode?: string;
  shuffle?: boolean;
  playingFrom?: string | null;
  playingFromId?: string | null;
}

export interface AudioRestore {
  plan: HeadlessPlan | null;
  played: { index: number; id: string; at: number }[];
  moved: boolean;
  pending?: boolean;
  volume?: number | null;
  snap: EngineSnapshot & { muted?: boolean };
  disk: {
    plan: HeadlessPlan | null;
    progress: number;
    wasPlaying: boolean;
    moved: boolean;
    savedAt: number;
  } | null;
  // to, co wtyczki naliczyły w Ruście, gdy okna nie było
  ext?: {
    handoff: ListenHandoff | null;
    stats: { totalSeconds: number; trackMinutes: Record<string, number>; sessions: number };
    failed: { service: string; s: Scrobble }[];
    sleepEndsAt: number;
  } | null;
}

let native = false;
let restore: AudioRestore | null = null;

export const OUTPUT_DEVICE_KEY = 'zenith_audio_output';

export async function initAudioBackend(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    native = await NativeAudio.available();
    if (native) restore = await invoke<AudioRestore>('zaudio_attach');
    // urządzenie otwiera się dopiero przy graniu, więc ustawienie zdąży przed pierwszym dźwiękiem
    const device = localStorage.getItem(OUTPUT_DEVICE_KEY);
    if (native && device) void invoke('zaudio_set_output_device', { name: device });
  } catch {
    native = false;
  }
}

export function isNativeAudio() {
  return native;
}

export function createAudio(): PlayerAudio {
  return native ? new NativeAudio(restore?.snap ?? null) : new DualAudio();
}

export function takeAudioRestore(): AudioRestore | null {
  const r = restore;
  restore = null;
  return r;
}

export function isRestoredUi(): boolean {
  return Boolean((window as unknown as { __ZENITH_RESTORED__?: boolean }).__ZENITH_RESTORED__);
}
