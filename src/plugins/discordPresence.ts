import { invoke } from '@tauri-apps/api/core';
import { NowPlayingInfo, ZenithPlugin } from './types';

/**
 * discord app id that shows as the activity name
 * override with zenith_discord_client_id in localStorage if you made your own app
 */
const DEFAULT_CLIENT_ID = '1514342633374486709';

const MIN_UPDATE_INTERVAL_MS = 4000;

function getClientId(): string {
  try {
    return localStorage.getItem('zenith_discord_client_id') || DEFAULT_CLIENT_ID;
  } catch {
    return DEFAULT_CLIENT_ID;
  }
}

let lastSentKey = '';
let lastSentAt = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function send(info: NowPlayingInfo) {
  lastSentAt = Date.now();
  invoke('discord_update_presence', {
    payload: {
      clientId: getClientId(),
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      position: info.position,
      isPlaying: info.isPlaying,
      coverUrl: info.coverUrl || null,
      trackUrl: `https://music.youtube.com/watch?v=${info.id}`,
    },
  }).catch((err) => {
    // discord just isnt running, dont tank playback over it
    // jak discord nie wisi to olewam, muzyka wazniejsza
    console.warn('[plugin:discord-rpc]', err);
  });
}

export const discordPresencePlugin: ZenithPlugin = {
  id: 'discord-rpc',
  name: 'Discord Rich Presence',
  category: 'social',
  description:
    'Shows the currently playing track, artist, cover art and a live progress bar on your Discord profile.',
  defaultEnabled: false,

  onNowPlaying(info: NowPlayingInfo | null) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (!info) {
      lastSentKey = '';
      invoke('discord_clear_presence').catch(() => {});
      return;
    }
    // skip live position noise, seeks are rate limited, real track changes go out now
    const key = `${info.id}|${info.isPlaying}|${Math.round(info.duration)}`;
    const elapsed = Date.now() - lastSentAt;
    if (key !== lastSentKey || elapsed >= MIN_UPDATE_INTERVAL_MS) {
      lastSentKey = key;
      send(info);
    } else {
      // scrubbing fires a ton of these, collapse to one at the end
      const wait = MIN_UPDATE_INTERVAL_MS - elapsed;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastSentKey = key;
        send({ ...info, position: info.position + wait / 1000 });
      }, wait);
    }
  },

  onDisable() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    lastSentKey = '';
    invoke('discord_disconnect').catch(() => {});
  },
};
