import { NowPlayingInfo, ZenithPlugin } from './types';

/** ambient color comes from applyCoverTheme, dont spin another canvas */
export const ambientGlowPlugin: ZenithPlugin = {
  id: 'ambient-glow',
  name: 'Ambient Cover Glow',
  category: 'visual',
  description: 'Tints the player backdrop with colors sampled from the current album art.',
  defaultEnabled: true,
  onTrackChange(info: NowPlayingInfo | null) {
    const root = document.querySelector('.zenith-app') as HTMLElement | null;
    if (!root) return;
    if (!info?.coverUrl) {
      root.style.removeProperty('--ambient-color');
      return;
    }
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--theme-accent')
      .trim();
    if (accent) root.style.setProperty('--ambient-color', accent);
  },
  onDisable() {
    (document.querySelector('.zenith-app') as HTMLElement | null)?.style.removeProperty(
      '--ambient-color'
    );
  },
};
