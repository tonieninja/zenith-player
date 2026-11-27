// Jasny motyw powstaje przy budowaniu: za każdą regułą z wpisanym na sztywno kolorem trafia jej jasna kopia.
// Dzięki temu nowe reguły w App.css same dostają jasną wersję, a ręczne poprawki są w light.css.

export interface LightDecl {
  prop: string;
  value: string;
  important?: boolean;
}

type Rgba = [number, number, number, number];

const SCOPE = "[data-theme='light']";
// atrament jasnego motywu: chłodna czerń, ta sama rodzina co ciemne tła aplikacji
const INK_HUE = 225;
const INK_SAT = 0.16;
const INK_L = 0.09;

// elementy na okładce zostają ciemne, a kod QR musi mieć białe tło, żeby telefon go odczytał
const KEEP =
  /\.(yt-card-overlay|yt-card-play-btn|search-result-play-icon|explore-trending-play|cover-vol-badge|global-modal-overlay|queue-drawer-backdrop|pm-dialog-backdrop|login-busy-overlay|onboarding-backdrop|onboarding-spotlight-hole|remote-qr|win-ctrl-close)(?![\w-])/;

// słowa kolorów tylko samodzielne, bo var(--rich-black-2) to nazwa zmiennej, nie czerń
const COLOR = /rgba?\([^()]*\)|#[0-9a-fA-F]{3,8}\b|(?<![\w-])(?:white|black)(?![\w-])/g;
const SKIP_PROP = /^(?:-webkit-)?mask|^content$/;
const TEXT_PROP =
  /^(?:color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color)$/;

function parse(c: string): Rgba | null {
  const s = c.toLowerCase();
  if (s === 'white') return [255, 255, 255, 1];
  if (s === 'black') return [0, 0, 0, 1];
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const parts = s
    .slice(s.indexOf('(') + 1, -1)
    .split(/[\s,/]+/)
    .filter(Boolean);
  if (parts.length < 3 || parts.some((p) => p.includes('var') || p.includes('%'))) return null;
  const [r, g, b, a = '1'] = parts.map(String);
  return [Number(r), Number(g), Number(b), Number(a)];
}

function hsl([r, g, b]: Rgba): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number, a: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const q = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  const al = Math.round(a * 1000) / 1000;
  return al >= 1 ? `rgb(${f(0)}, ${f(8)}, ${f(4)})` : `rgba(${f(0)}, ${f(8)}, ${f(4)}, ${al})`;
}

type Role = 'text' | 'surface' | 'shadow' | 'textShadow';

/** Jasny odpowiednik koloru zależnie od roli; null, gdy kolor zostaje bez zmian. */
export function lightColor(c: string, role: Role): string | null {
  const rgba = parse(c);
  if (!rgba) return null;
  const a = rgba[3];
  const [h, s, l] = hsl(rgba);
  if (role === 'shadow' || role === 'textShadow') {
    // jasne poświaty znikają na jasnym tle same, a czarny cień jest tam za ciężki; rozmyty cień
    // pod dużym napisem przycina ramka elementu, więc na jasnym tle widać by szary prostokąt
    return l < 0.5 ? fromHsl(h, s, l, a * (role === 'shadow' ? 0.5 : 0.15)) : null;
  }
  // nasycony kolor tła (czerwony przycisk, pasek postępu) wygląda tak samo w obu motywach
  if (role === 'surface' && s >= 0.45 && l >= 0.3 && l <= 0.68 && a >= 0.5) return null;
  const neutral = s < 0.1;
  const hue = neutral ? INK_HUE : h;
  const sat = neutral ? INK_SAT : s;
  // nieprzezroczyste ciemne tła: wyżej położona warstwa była jaśniejsza, więc w jasnym jest bielsza
  if (role === 'surface' && a >= 0.75 && l < 0.22)
    return fromHsl(hue, Math.min(sat, 0.3), Math.min(1, 0.94 + l * 0.45), a);
  return fromHsl(hue, sat, INK_L + (1 - l) * (1 - INK_L), a);
}

function role(prop: string): Role {
  if (prop === 'text-shadow') return 'textShadow';
  if (/shadow/.test(prop) || prop === 'filter') return 'shadow';
  return TEXT_PROP.test(prop) ? 'text' : 'surface';
}

export function lightValue(prop: string, value: string): string | null {
  if (SKIP_PROP.test(prop) || value.includes(SCOPE)) return null;
  let changed = false;
  const out = value.replace(COLOR, (m) => {
    const c = lightColor(m, role(prop));
    if (c === null) return m;
    changed = true;
    return c;
  });
  return changed ? out : null;
}

export function lightSelector(sel: string): string {
  const s = sel.trim();
  const top = /^(:root|html)(?![\w-])/.exec(s);
  return top ? `${top[1]}:where(${SCOPE})${s.slice(top[1].length)}` : `:where(:root${SCOPE}) ${s}`;
}

const isWhite = (v: string) => {
  const c = v.match(COLOR);
  return (
    !!c &&
    c.every((x) => {
      const p = parse(x);
      return !!p && hsl(p)[2] > 0.85;
    })
  );
};

/** Jasna kopia reguły albo null, gdy reguła nie ma kolorów do zmiany. */
export function lightRule(
  selectors: string[],
  decls: LightDecl[]
): { selector: string; decls: LightDecl[] } | null {
  if (selectors.some((s) => s.includes(SCOPE) || KEEP.test(s) || /^(from|to|[\d.]+%)$/.test(s)))
    return null;
  const bg = decls.find((d) => /^background(-color)?$/.test(d.prop));
  // biały napis na akcencie albo nasyconym tle zostaje biały, bo to tło się nie odwraca
  const keepWhiteText =
    !!bg &&
    ((/var\(--(theme-)?accent/.test(bg.value) && !/color-mix|transparent/.test(bg.value)) ||
      (!!bg.value.match(COLOR) && lightValue(bg.prop, bg.value) === null));
  const out: LightDecl[] = [];
  let shorthand = false;
  for (const d of decls) {
    if (keepWhiteText && d.prop === 'color' && isWhite(d.value)) continue;
    const value = lightValue(d.prop, d.value);
    if (value !== null) out.push({ prop: d.prop, value, important: d.important });
    // skrót background zeruje clip i rozmiar, więc dalsze właściwości tła z oryginału idą za nim
    else if (shorthand && /^(-webkit-)?background-/.test(d.prop)) out.push(d);
    if (value !== null && d.prop === 'background') shorthand = true;
  }
  return out.length ? { selector: selectors.map(lightSelector).join(',\n'), decls: out } : null;
}
