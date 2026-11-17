import { invoke } from '@tauri-apps/api/core';
import { isNativeAudio } from '../audio/engine';
import { NowPlayingInfo, ZenithPlugin } from './types';

let last: NowPlayingInfo | null = null;

export interface MprisExtras {
  volume: number;
  rate: number;
  loopMode: 'off' | 'all' | 'one';
  shuffle: boolean;
}
let extras: MprisExtras | null = null;

// pozycja przychodzi od wołającego, bo `last` pamięta ją tylko z ostatniej zmiany utworu lub pauzy
export function setMprisExtras(e: MprisExtras, position: number) {
  extras = e;
  if (last) pushNative({ ...last, position });
}

// wybór tempa żyje w panelu wtyczek, a MPRIS liczy z niego pozycję między aktualizacjami
export function setMprisRate(rate: number, position: number) {
  if (extras) extras = { ...extras, rate };
  if (last) pushNative({ ...last, position });
}

function pushNative(info: NowPlayingInfo | null, playing?: boolean) {
  if (!isNativeAudio()) return;
  last = info;
  void invoke('mpris_update', {
    title: info?.title ?? null,
    artist: info?.artist ?? null,
    // systemowy panel multimediów pobiera okładkę sam, więc adres data: nic by mu nie dał
    art: info?.coverUrl?.startsWith('http') ? info.coverUrl : null,
    playing: playing ?? info?.isPlaying ?? false,
    position: info?.position ?? 0,
    duration: info?.duration ?? 0,
    volume: extras?.volume ?? null,
    rate: extras?.rate ?? null,
    loopMode: extras?.loopMode ?? null,
    shuffle: extras?.shuffle ?? null,
  });
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
      position: Math.max(0, Math.min(info.position || 0, info.duration)),
      playbackRate: 1,
    });
  }
}

function wireActions() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => handlers.play?.());
  navigator.mediaSession.setActionHandler('pause', () => handlers.pause?.());
  navigator.mediaSession.setActionHandler('previoustrack', () => handlers.prev?.());
  navigator.mediaSession.setActionHandler('nexttrack', () => handlers.next?.());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') handlers.seek?.(details.seekTime);
  });
}

export const mediaSessionPlugin: ZenithPlugin = {
  id: 'media-session',
  name: 'Media session',
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
      navigator.mediaSession.setActionHandler(action, null);
    }
  },
  onNowPlaying(info) {
    if (!info) {
      syncMetadata(null);
      return;
    }
    syncMetadata(info);
  },
  // bez tego pasek postępu w panelu systemu zostaje w starym miejscu po przewinięciu w aplikacji
  onSeek(position) {
    if (last) pushNative({ ...last, position });
  },
  onPlayStateChange(isPlaying) {
    if (last) pushNative({ ...last, isPlaying }, isPlaying);
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  },
};
