import { fetch } from '@tauri-apps/plugin-http';
import { useEffect, useState } from 'react';
import { storedFlag } from './flag';
import { romanizeOffThread } from './romanizeClient';

export const romanizeLyrics = storedFlag('zenith_lyrics_romanize');
export const translateLyrics = storedFlag('zenith_lyrics_translate');

export interface LineExtras {
  roman?: string;
  trans?: string;
}

type Lines = (string | undefined)[];

const GTX = 'https://translate.googleapis.com/translate_a';
// Google tnie zapytania powyżej ~5000 znaków, zostawiamy zapas na kodowanie
const CHUNK_CHARS = 3000;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function chunks(texts: string[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  texts.forEach((t, i) => {
    if (cur.length && size + t.length > CHUNK_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += t.length + 3;
  });
  if (cur.length) out.push(cur);
  return out;
}

// translate_a/t zwraca tekst albo [tekst, wykryty język], zależnie od liczby q
export function parseTranslations(data: unknown, count: number): [string, string | null][] | null {
  if (!Array.isArray(data) || data.length !== count) return null;
  return data.map((d): [string, string | null] => {
    if (typeof d === 'string') return [d, null];
    if (Array.isArray(d) && typeof d[0] === 'string') {
      return [d[0], typeof d[1] === 'string' ? d[1] : null];
    }
    return ['', null];
  });
}

async function translate(texts: string[], to: string): Promise<Lines> {
  const out: Lines = [];
  for (const part of chunks(texts)) {
    const body = new URLSearchParams();
    for (const i of part) body.append('q', texts[i]);
    const res = await fetch(`${GTX}/t?client=gtx&sl=auto&tl=${encodeURIComponent(to)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
    const got = parseTranslations(await res.json(), part.length);
    if (!got) continue;
    part.forEach((i, k) => {
      const [text, from] = got[k];
      if (text && from !== to && !same(text, texts[i])) out[i] = text;
    });
  }
  return out;
}

// klucz bez przedrostka zenith, żeby tłumaczenia nie trafiały do kopii ustawień na dysku
const SHARED_KEY = 'zh_translated_v1';
type Stored = [string, (string | null)[]][];

const readShared = (): Stored => {
  try {
    const v = JSON.parse(localStorage.getItem(SHARED_KEY) || '[]');
    return Array.isArray(v) ? (v as Stored) : [];
  } catch {
    return [];
  }
};

// każde okno z tekstem (główne, mini, nakładka) tłumaczyłoby to samo; pod blokadą robi to tylko pierwsze
function sharedTranslate(texts: string[], to: string): Promise<Lines> {
  const key = to + ':' + texts.join('\n');
  const run = async (): Promise<Lines> => {
    const hit = readShared().find(([k]) => k === key);
    if (hit) return hit[1].map((l) => l ?? undefined);
    const out = await translate(texts, to);
    try {
      const rest = readShared().filter(([k]) => k !== key);
      rest.push([key, Array.from(out, (l) => l ?? null)]);
      localStorage.setItem(SHARED_KEY, JSON.stringify(rest.slice(-8)));
    } catch {
      /* pełny localStorage: inne okno przetłumaczy samo */
    }
    return out;
  };
  return navigator.locks ? navigator.locks.request('zenith-translate', run) : run();
}

const cache = new Map<string, Promise<Lines>>();

function cached(key: string, run: () => Promise<Lines>): Promise<Lines> {
  let p = cache.get(key);
  if (!p) {
    p = run().catch((e) => {
      // błąd nie zostaje w cache, żeby kolejne otwarcie piosenki spróbowało jeszcze raz
      cache.delete(key);
      console.error('[Zenith] lyrics extras failed', e);
      return [];
    });
    cache.set(key, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

const RETRY_MS = 5000;
const RETRIES = 3;

function useExtra(on: boolean, key: string, run: () => Promise<Lines>): Lines {
  const [got, setGot] = useState<{ key: string; lines: Lines } | null>(null);
  const [tries, setTries] = useState({ key: '', n: 0 });
  const attempt = tries.key === key ? tries.n : 0;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let retry = 0;
    void cached(key, run).then((lines) => {
      if (!alive) return;
      setGot({ key, lines });
      // pusty wynik bywa błędem workera lub sieci; prawdziwie pusty leży w magazynie i ponowienie tylko go odczyta
      if (!lines.length && attempt < RETRIES) {
        retry = window.setTimeout(() => setTries({ key, n: attempt + 1 }), RETRY_MS);
      }
    });
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
    // run wynika z key, a nowa funkcja w każdym renderze odpalałaby efekt w kółko
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, attempt]);
  return on && got?.key === key ? got.lines : [];
}

export function useLyricsExtras(texts: string[], translateTo: string): LineExtras[] {
  const joined = texts.join('\n');
  const roman = useExtra(romanizeLyrics.useValue() && !!joined, `r:${joined}`, () =>
    romanizeOffThread(joined.split('\n'))
  );
  const trans = useExtra(translateLyrics.useValue() && !!joined, `t:${translateTo}:${joined}`, () =>
    sharedTranslate(joined.split('\n'), translateTo)
  );
  if (!roman.length && !trans.length) return [];
  return texts.map((_, i) => ({ roman: roman[i], trans: trans[i] }));
}
