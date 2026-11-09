import { romanizeLines } from './romanize';

type Lines = (string | undefined)[];
type Reply = { id: number; out?: Lines; err?: string };

const STORE_KEY = 'zenith_romanized_v1';
const STORE_MAX = 60;
// wolny CDN ze słownikiem nie może zawiesić obietnicy (i workera) do restartu
const JOB_TIMEOUT_MS = 60_000;

// słownik kuromoji to ~300 MB, a wczytuje się w ~0,3 s: worker żyje tylko na czas jednej piosenki
function inWorker(lines: string[]): Promise<Lines> {
  if (typeof Worker !== 'function') return romanizeLines(lines);
  const w = new Worker(new URL('./romanize.worker.ts', import.meta.url), { type: 'module' });
  let timer = 0;
  return new Promise<Lines>((resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error('romanize timeout')), JOB_TIMEOUT_MS);
    w.onmessage = (e: MessageEvent<Reply>) =>
      e.data.err ? reject(new Error(e.data.err)) : resolve(e.data.out ?? []);
    w.onerror = () => reject(new Error('romanize worker crashed'));
    w.postMessage({ id: 1, lines });
  }).finally(() => {
    window.clearTimeout(timer);
    w.terminate();
  });
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + text.length.toString(36);
}

function readStore(): Record<string, Lines> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function remember(key: string, lines: Lines) {
  const store = readStore();
  delete store[key];
  store[key] = lines;
  const keys = Object.keys(store);
  for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete store[k];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
}

export async function romanizeOffThread(lines: string[]): Promise<Lines> {
  const key = hash(lines.join('\n'));
  // powtórka piosenki nie budzi workera ani nie ładuje słownika drugi raz
  const cached = () => readStore()[key]?.map((l) => l ?? undefined);
  const run = async (): Promise<Lines> => {
    const known = cached();
    if (known) return known;
    const out = await inWorker(lines);
    // JSON zamienia dziury w tablicy na null, a null nie jest linią do pokazania
    remember(key, out.map((l) => l ?? null) as Lines);
    return out;
  };
  // okna (główne, mini, nakładki) proszą o te same linie naraz: pod blokadą słownik jest tylko jeden
  return cached() ?? (navigator.locks ? navigator.locks.request('zenith-romanize', run) : run());
}
