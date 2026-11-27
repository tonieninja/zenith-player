import { invoke } from '@tauri-apps/api/core';
import { searchSongsStrict, type Section, type Track } from '../api/youtube';
import type { Language } from '../i18n';
import { ZenithPlugin } from './types';

interface Pick {
  artist: string;
  title: string;
  because: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Utwór z YouTube Music dla propozycji z Deezera; wykonawca musi się zgadzać, inaczej to inna piosenka. */
async function findOnYtm(p: Pick, lang: Language): Promise<Track | null> {
  const found = await searchSongsStrict(`${p.artist} ${p.title}`, lang).catch(() => []);
  const who = norm(p.artist);
  return found.find((t) => norm(t.artist).includes(who)) ?? null;
}

export async function discoverSection(lang: Language, title: string): Promise<Section | null> {
  const picks = await invoke<Pick[]>('discover_picks').catch(() => []);
  const items: Track[] = [];
  // po cztery naraz: szesnaście wyszukiwań na raz YouTube Music potrafi uciąć
  for (let i = 0; i < picks.length; i += 4) {
    const batch = await Promise.all(picks.slice(i, i + 4).map((p) => findOnYtm(p, lang)));
    for (const t of batch) if (t && !items.some((x) => x.id === t.id)) items.push(t);
  }
  return items.length >= 4 ? { title, items } : null;
}

export const discoverPlugin: ZenithPlugin = {
  id: 'discover',
  name: 'Discover',
  category: 'integrations',
  description:
    'Adds a home row with artists close to the ones you play most, found through Deezer. Only the names of your top artists are sent.',
  defaultEnabled: false,
};
