import { invoke } from '@tauri-apps/api/core';
import { createScrobbler } from './scrobbler';

export interface ListenbrainzStatus {
  user: string | null;
}

export const listenbrainzStatus = () => invoke<ListenbrainzStatus>('listenbrainz_status');
export const listenbrainzSetToken = (token: string) =>
  invoke<ListenbrainzStatus>('listenbrainz_set_token', { token });
export const listenbrainzLogout = () => invoke<ListenbrainzStatus>('listenbrainz_logout');

export const listenbrainzPlugin = createScrobbler({
  id: 'listenbrainz-scrobbler',
  name: 'ListenBrainz',
  description: 'Sends what you listen to to your ListenBrainz profile.',
  queueKey: 'zenith.listenbrainz.queue',
  nowPlaying: (t) => invoke('listenbrainz_now_playing', { t }),
  submit: (t) => invoke('listenbrainz_submit', { t }),
});

export function listenbrainzErrorText(raw: string, t: Record<string, string>): string {
  if (/listenbrainz 401/.test(raw)) return t.lbErrToken;
  if (/listenbrainz 429/.test(raw)) return t.lbErrRate;
  if (/timed out|error sending request|dns|connect/i.test(raw)) return t.lfmErrNetwork;
  return `${t.lfmErrOther} (${raw})`;
}
