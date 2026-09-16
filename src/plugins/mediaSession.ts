import { NowPlayingInfo, ZenithPlugin } from './types';

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
  category: 'utility',
  description: 'OS Now Playing / lock-screen controls and media keys integration.',
  defaultEnabled: true,
  onEnable() {
    wireActions();
  },
  onDisable() {
    syncMetadata(null);
  },
  onNowPlaying(info) {
    if (!info) {
      syncMetadata(null);
      return;
    }
    syncMetadata(info);
  },
  onPlayStateChange(isPlaying) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch {}
  },
};
