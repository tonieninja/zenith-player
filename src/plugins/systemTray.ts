import { invoke } from '@tauri-apps/api/core';
import { ZenithPlugin } from './types';

/** the tray icon itself lives in rust, this toggle decides whether X hides to tray or quits */
export async function syncCloseToTray(enabled: boolean): Promise<boolean> {
  try {
    return await invoke<boolean>('set_close_to_tray', { enabled });
  } catch {
    return false;
  }
}

export const systemTrayPlugin: ZenithPlugin = {
  id: 'system-tray',
  name: 'System Tray',
  category: 'interface',
  description:
    'Closing the window keeps Zenith playing in the tray, with play/pause, next and show controls.',
  defaultEnabled: true,
  onEnable() {
    void syncCloseToTray(true);
  },
  onDisable() {
    void syncCloseToTray(false);
  },
};
