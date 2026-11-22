import { invoke } from '@tauri-apps/api/core';
import { currentT } from '../i18n';
import { ZenithPlugin } from './types';

let on = false;
let playing = false;

function push() {
  const t = currentT();
  void invoke('thumbbar_update', {
    on,
    playing,
    tips: [t.previousTrack, t.play, t.pause, t.nextTrack],
  }).catch(() => undefined);
}

export const taskbarButtonsPlugin: ZenithPlugin = {
  id: 'taskbar-buttons',
  name: 'Taskbar buttons',
  category: 'control',
  description: 'Previous, play/pause and next under the window preview on the Windows taskbar.',
  defaultEnabled: false,
  onEnable() {
    on = true;
    push();
  },
  onDisable() {
    on = false;
    push();
  },
  onPlayStateChange(isPlaying) {
    playing = isPlaying;
    if (on) push();
  },
};
