import { describe, expect, it } from 'vitest';
import { saveUiSnapshot, takeUiSnapshot, type UiSnapshot } from '../utils/uiSnapshot';

const snap: UiSnapshot = {
  tab: 'mood',
  prevTab: 'search',
  activeMood: 'browse:MPREb_x',
  browseTitle: 'All Night Radio',
  browseEmptyKind: null,
  sections: [{ title: 'All Night Radio', items: [] }],
  homeSections: [],
  exploreSections: [],
  quickPicks: [],
  searchQuery: 'ado',
  libCategory: 'landing',
  panelTab: 'upnext',
  collection: null,
  scrollTop: 420,
};

describe('ui snapshot', () => {
  it('comes back once, exactly as saved', () => {
    saveUiSnapshot(snap);
    expect(takeUiSnapshot()).toEqual(snap);
    expect(takeUiSnapshot()).toBeNull();
  });

  it('drops broken data instead of restoring half a view', () => {
    localStorage.setItem('zenith_ui_snapshot', '{"tab":');
    expect(takeUiSnapshot()).toBeNull();
    localStorage.setItem('zenith_ui_snapshot', '{"tab":"home"}');
    expect(takeUiSnapshot()).toBeNull();
  });
});
