import { NowPlayingInfo, ZenithPlugin } from './types';

export const copyTrackLinkPlugin: ZenithPlugin = {
  id: 'copy-track-link',
  name: 'Copy Track Link',
  category: 'utility',
  description:
    'Automatically copies the YouTube Music link when you start a new track (Ctrl+C still works).',
  defaultEnabled: false,
  onTrackChange(info: NowPlayingInfo | null) {
    if (!info) return;
    const url = `https://music.youtube.com/watch?v=${info.id}`;
    navigator.clipboard?.writeText(url).catch(() => {});
  },
};
