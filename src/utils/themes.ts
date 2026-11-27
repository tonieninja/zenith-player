export interface Theme {
  id: string;
  en: string;
  pl: string;
  accent: string;
  accent2: string;
  accent3: string;
}

export const THEMES: Theme[] = [
  {
    id: 'zenith',
    en: 'Zenith blue',
    pl: 'Niebieski Zenith',
    accent: '#7eb4ff',
    accent2: '#4d8cff',
    accent3: '#2f6fd4',
  },
  {
    id: 'violet',
    en: 'Violet',
    pl: 'Fiolet',
    accent: '#b9a4ff',
    accent2: '#8b6cff',
    accent3: '#6a4ad9',
  },
  {
    id: 'emerald',
    en: 'Emerald',
    pl: 'Szmaragd',
    accent: '#7fe0b4',
    accent2: '#2fbf84',
    accent3: '#1f9466',
  },
  { id: 'rose', en: 'Rose', pl: 'Róż', accent: '#ff9ec4', accent2: '#f0609a', accent3: '#c93f78' },
  {
    id: 'amber',
    en: 'Amber',
    pl: 'Bursztyn',
    accent: '#ffd08a',
    accent2: '#f2a93b',
    accent3: '#c9821c',
  },
  {
    id: 'cyan',
    en: 'Cyan',
    pl: 'Turkus',
    accent: '#8be8f2',
    accent2: '#2cc4d6',
    accent3: '#1b96a6',
  },
  {
    id: 'crimson',
    en: 'Crimson',
    pl: 'Karmazyn',
    accent: '#ff9a8f',
    accent2: '#ec5a4c',
    accent3: '#c13b2f',
  },
  {
    id: 'mono',
    en: 'Graphite',
    pl: 'Grafit',
    accent: '#e8eaef',
    accent2: '#b4b9c4',
    accent3: '#868c99',
  },
];

const KEY = 'zenith_theme';

export function currentTheme(): Theme {
  const id = localStorage.getItem(KEY);
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

const glow = (hex: string, a: number) => `rgba(${rgbOf(hex).join(', ')}, ${a})`;

export const isLightTheme = () => document.documentElement.dataset.theme === 'light';

const luminance = (c: number[]) =>
  [0.2126, 0.7152, 0.0722].reduce((sum, w, i) => {
    const v = c[i]! / 255;
    return sum + w * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0);

/** Akcent na jasne tło: kolor ciemnieje, aż jego luminancja spadnie do maxLum (0.14 daje ok. 4.5:1). */
export function inkAccent(rgb: number[], maxLum = 0.14): string {
  let c = rgb;
  while (luminance(c) > maxLum) c = c.map((v) => v * 0.94);
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Barwy motywu; motyw z okładki (ambient glow) nakłada się na nie i wraca do nich po wyłączeniu. */
export function themeVars(t = currentTheme()) {
  const light = isLightTheme();
  return {
    accent: light ? inkAccent(rgbOf(t.accent3)) : t.accent,
    accent2: light ? inkAccent(rgbOf(t.accent3), 0.2) : t.accent2,
    accent3: t.accent3,
    glow: glow(t.accent2, 0.28),
    mesh1: glow(t.accent2, 0.12),
    mesh2: glow(t.accent, 0.06),
  };
}

export function applyTheme(id?: string) {
  if (id) localStorage.setItem(KEY, id);
  const v = themeVars();
  const root = document.documentElement.style;
  root.setProperty('--accent-3', v.accent3);
  // przy poświacie akcent daje okładka; motyw wróci, gdy poświata się wyłączy (resetCoverTheme)
  if (document.documentElement.classList.contains('has-cover-theme')) return;
  root.setProperty('--accent-1', v.accent);
  root.setProperty('--accent-2', v.accent2);
  root.setProperty('--accent-glow', v.glow);
  root.setProperty('--theme-mesh-1', v.mesh1);
  root.setProperty('--theme-mesh-2', v.mesh2);
}
