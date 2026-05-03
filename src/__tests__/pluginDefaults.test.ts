import { describe, expect, it } from 'vitest';
import { ALL_PLUGINS, PLUGIN_ORDER, pluginManager } from '../plugins';
import { PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER } from '../plugins/types';
import { pluginText } from '../utils/pluginI18n';

const CORE_ON = [
  'preload-next',
  'queue-persist',
  'remember-volume',
  'smart-lyrics',
  'media-session',
  'global-hotkeys',
  'keyboard-shortcuts',
  'system-tray',
];

describe('plugin defaults and grouping', () => {
  it('only the core plugins start enabled on a fresh install', () => {
    const on = ALL_PLUGINS.filter((p) => p.defaultEnabled)
      .map((p) => p.id)
      .sort();
    expect(on).toEqual([...CORE_ON].sort());
  });

  it('every plugin has a known category, a place in the order and texts in both languages', () => {
    for (const p of ALL_PLUGINS) {
      expect(PLUGIN_CATEGORY_ORDER).toContain(p.category);
      expect(PLUGIN_ORDER).toContain(p.id);
      for (const lang of ['en', 'pl'] as const) {
        const t = pluginText(lang, p.id, { name: '', desc: '' });
        expect(t.name, `${p.id} ${lang}`).not.toBe('');
        expect(t.desc).not.toMatch(/\u2014/);
      }
    }
    for (const c of PLUGIN_CATEGORY_ORDER) expect(PLUGIN_CATEGORY_LABELS[c].pl).toBeTruthy();
  });

  it('groups come back in display order', () => {
    const g = pluginManager.byCategory();
    expect(Object.keys(g)).toEqual(PLUGIN_CATEGORY_ORDER);
    expect(g.sound[0].id).toBe('equalizer');
    expect(g.playback[0].id).toBe('preload-next');
    expect(ALL_PLUGINS.length).toBe(PLUGIN_ORDER.length);
  });
});

describe('saved plugin choices after a storage restore', () => {
  it('reloadFromStorage picks up choices restored after import', () => {
    localStorage.setItem(
      'zenith_plugins_enabled',
      JSON.stringify({ crossfade: true, 'preload-next': false })
    );
    pluginManager.reloadFromStorage();
    expect(pluginManager.isEnabled('crossfade')).toBe(true);
    expect(pluginManager.isEnabled('preload-next')).toBe(false);
    expect(pluginManager.isEnabled('equalizer')).toBe(false);
    localStorage.removeItem('zenith_plugins_enabled');
    pluginManager.reloadFromStorage();
  });
});
