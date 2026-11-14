import { ZenithPlugin } from './types';

// sam identyfikator utworu, bez si= i innych parametrów śledzących z przycisku Udostępnij w YouTube
export function trackLink(id: string, seconds?: number): string {
  const url = `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const t = Math.floor(seconds ?? 0);
  return t > 0 ? `${url}&t=${t}` : url;
}

export async function copyTrackLink(id: string, seconds?: number): Promise<boolean> {
  const url = trackLink(id, seconds);
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(url);
    return true;
  } catch {
    return navigator.clipboard
      ?.writeText(url)
      .then(() => true)
      .catch(() => false);
  }
}

export const copyTrackLinkPlugin: ZenithPlugin = {
  id: 'copy-track-link',
  name: 'Copy Track Link',
  category: 'integrations',
  description:
    'Right click the cover in the player to copy a clean YouTube Music link, with or without the current time.',
  defaultEnabled: false,
};
