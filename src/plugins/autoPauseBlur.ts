import { ZenithPlugin } from './types';

let pauseCallback: (() => void) | null = null;

export function registerAutoPauseCallback(cb: () => void) {
  pauseCallback = cb;
}

export const autoPauseBlurPlugin: ZenithPlugin = {
  id: 'auto-pause-blur',
  name: 'Pause When Unfocused',
  category: 'playback',
  description: 'Pauses playback when you switch to another app or minimize Zenith.',
  defaultEnabled: false,
  onAppFocus(focused) {
    if (!focused) pauseCallback?.();
  },
};
