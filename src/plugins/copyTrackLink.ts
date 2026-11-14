import { NowPlayingInfo, ZenithPlugin } from './types';

export const copyTrackLinkPlugin: ZenithPlugin = {
  id: 'copy-track-link',
  name: 'Copy Track Link',
  category: 'integrations',
  description: 'Copies the YouTube Music link to the clipboard every time a new track starts.',
  defaultEnabled: false,
  async onTrackChange(info: NowPlayingInfo | null) {
    if (!info) return;
    const url = `https://music.youtube.com/watch?v=${info.id}`;
    // zmiana utworu zwykle dzieje się przy oknie w tle, a wtedy navigator.clipboard odmawia
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(url);
    } catch {
      await navigator.clipboard
        ?.writeText(url)
        .catch((err) => console.debug('copyTrackLink onTrackChange', err));
    }
  },
};
