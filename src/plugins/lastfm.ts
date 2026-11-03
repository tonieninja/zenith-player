import { invoke } from '@tauri-apps/api/core';
import { createScrobbler } from './scrobbler';

export interface LastfmStatus {
  configured: boolean;
  user: string | null;
  pending: boolean;
}

export const lastfmStatus = () => invoke<LastfmStatus>('lastfm_status');
export const lastfmSetKeys = (apiKey: string, secret: string) =>
  invoke<LastfmStatus>('lastfm_set_keys', { apiKey, secret });
export const lastfmBeginAuth = () => invoke<string>('lastfm_begin_auth');
export const lastfmFinishAuth = () => invoke<LastfmStatus>('lastfm_finish_auth');
export const lastfmLogout = () => invoke<LastfmStatus>('lastfm_logout');

export const lastfmPlugin = createScrobbler({
  id: 'lastfm-scrobbler',
  name: 'Last.fm scrobbler',
  description:
    'Scrobbles what you listen to to your Last.fm profile and shows "now playing" there.',
  queueKey: 'zenith.lastfm.queue',
  nowPlaying: (t) => invoke('lastfm_now_playing', { t }),
  submit: (t) => invoke('lastfm_scrobble', { t }),
});

export function lastfmErrorText(raw: string, t: Record<string, string>): string {
  const code = /last\.fm (\d+)/.exec(raw)?.[1];
  const byCode: Record<string, string> = {
    '4': t.lfmErrAuth,
    '9': t.lfmErrSession,
    '10': t.lfmErrKey,
    '13': t.lfmErrSecret,
    '14': t.lfmErrNotApproved,
    '15': t.lfmErrExpired,
    '11': t.lfmErrOffline,
    '16': t.lfmErrOffline,
    '29': t.lfmErrRate,
  };
  if (code && byCode[code]) return byCode[code];
  if (/32 hex/.test(raw)) return t.lfmErrFormat;
  if (/set the API key first/.test(raw)) return t.lfmErrNoKey;
  if (/start the connection first/.test(raw)) return t.lfmErrNoPending;
  if (/not connected/.test(raw)) return t.lfmErrNotConnected;
  if (/timed out|error sending request|dns|connect/i.test(raw)) return t.lfmErrNetwork;
  return `${t.lfmErrOther} (${raw})`;
}
