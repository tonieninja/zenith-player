import { invoke } from '@tauri-apps/api/core';
import { isNativeAudio } from '../audio/engine';
import { NowPlayingInfo, ZenithPlugin } from './types';

let last: NowPlayingInfo | null = null;

function pushNative(info: NowPlayingInfo | null, playing?: boolean) {
  if (!isNativeAudio()) return;
  last = info;
  invoke('mpris_update', {
    title: info?.title ?? null,
    artist: info?.artist ?? null,
    art: info?.coverUrl ?? null,
    playing: playing ?? info?.isPlaying ?? false,
    position: info?.position ?? 0,
    duration: info?.duration ?? 0,
  }).catch(() => {});
}

let handlers: {
  play?: () => void;
  pause?: () => void;
  next?: () => void;
  prev?: () => void;
  seek?: (t: number) => void;
} = {};

export function registerMediaSessionHandlers(h: typeof handlers) {
  handlers = h;
}

function syncMetadata(info: NowPlayingInfo | null) {
  pushNative(info);
  if (!('mediaSession' in navigator)) return;
  try {
    if (!info) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist,
      artwork: info.coverUrl
        ? [
            { src: info.coverUrl, sizes: '512x512', type: 'image/jpeg' },
            { src: info.coverUrl, sizes: '256x256', type: 'image/jpeg' },
          ]
        : [],
    });
    navigator.mediaSession.playbackState = info.isPlaying ? 'playing' : 'paused';
    if (Number.isFinite(info.duration) && info.duration > 0) {
      navigator.mediaSession.setPositionState?.({
        duration: info.duration,
        position: Math.min(info.position, info.duration),
        playbackRate: 1,
      });
    }
  } catch {}
}

function wireActions() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => handlers.play?.());
    navigator.mediaSession.setActionHandler('pause', () => handlers.pause?.());
    navigator.mediaSession.setActionHandler('previoustrack', () => handlers.prev?.());
    navigator.mediaSession.setActionHandler('nexttrack', () => handlers.next?.());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') handlers.seek?.(details.seekTime);
    });
  } catch {}
}

export const mediaSessionPlugin: ZenithPlugin = {
  id: 'media-session',
  name: 'Media Session',
  category: 'control',
  description: 'OS Now Playing / lock-screen controls and media keys integration.',
  defaultEnabled: true,
  onEnable() {
    wireActions();
  },
  onDisable() {
    syncMetadata(null);
    if (!('mediaSession' in navigator)) return;
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'] as const) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {}
    }
  },
  onNowPlaying(info) {
    if (!info) {
      syncMetadata(null);
      return;
    }
    syncMetadata(info);
  },
  onPlayStateChange(isPlaying) {
    if (last) pushNative({ ...last, isPlaying }, isPlaying);
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}
  },
};
