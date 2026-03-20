import { invoke } from '@tauri-apps/api/core';
import { DualAudio } from './dualAudio';
import { NativeAudio, type EngineSnapshot } from './nativeAudio';
import type { Track } from '../api/youtube';

export type PlayerAudio = DualAudio | NativeAudio;

export interface HeadlessPlan {
  queue: Track[];
  index: number;
  loopMode?: string;
  playingFrom?: string | null;
  playingFromId?: string | null;
}

export interface AudioRestore {
  plan: HeadlessPlan | null;
  played: { index: number; id: string; at: number }[];
  moved: boolean;
  snap: EngineSnapshot & { muted?: boolean };
  disk: {
    plan: HeadlessPlan | null;
    progress: number;
    wasPlaying: boolean;
    moved: boolean;
    savedAt: number;
  } | null;
}

let native = false;
let restore: AudioRestore | null = null;

export async function initAudioBackend(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    native = await NativeAudio.available();
    if (native) restore = await invoke<AudioRestore>('zaudio_attach');
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
