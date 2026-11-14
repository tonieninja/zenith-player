import type { LibraryCategory, Section, Track } from '../api/youtube';
import type { ViewTab } from '../types/views';

const KEY = 'zenith_ui_snapshot';

/** Widok sprzed zwolnienia okna w zasobniku; nowe okno wraca dokładnie tu, bez pobierania od nowa. */
export interface UiSnapshot {
  tab: ViewTab;
  prevTab: ViewTab;
  activeMood: string | null;
  browseTitle: string | null;
  browseEmptyKind: 'episodes' | 'collection' | null;
  sections: Section[];
  homeSections: Section[];
  exploreSections: Section[];
  quickPicks: Track[];
  searchQuery: string;
  libCategory: LibraryCategory;
  panelTab: 'upnext' | 'related';
  collection: Track | null;
  scrollTop: number;
}

export function saveUiSnapshot(s: UiSnapshot) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // pełny localStorage: lepiej wrócić na start niż wczytać pół widoku
    localStorage.removeItem(KEY);
  }
}

export function takeUiSnapshot(): UiSnapshot | null {
  const raw = localStorage.getItem(KEY);
  localStorage.removeItem(KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as UiSnapshot;
    return typeof s?.tab === 'string' && Array.isArray(s.sections) ? s : null;
  } catch {
    return null;
  }
}

/** Przewija aktywny widok, gdy treść już się wyrenderuje; kilka klatek, bo listy rosną stopniowo. */
export function restoreScroll(top: number, tries = 30) {
  if (!(top > 0)) return;
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>('.content-area .content-scrollable');
    if (el) {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = top;
      if (Math.abs(el.scrollTop - top) <= 2 || tries <= 1) {
        el.style.scrollBehavior = '';
        return;
      }
    }
    if (tries > 1) restoreScroll(top, tries - 1);
  });
}
