import { fetch } from '@tauri-apps/plugin-http';
import { skipCurrent } from './blockArtists';
import { NowPlayingInfo, ZenithPlugin } from './types';

const BASE = 'https://ailist.flow-tube.org/v1/aimusic/';
// klucze publiczne listy według key_id; nowy klucz przychodzi z wydaniem aplikacji, stary zostaje do rotacji
const KEYS: Record<string, string> = {
  '2026-11': 'MCowBQYDK2VwAyEAxak9y4JaDG+UjKfl7cDwiaJs+7FjrOM+urMW1YfSuc0=',
};
// poza prefiksem zenith, żeby 200 KB identyfikatorów nie trafiało do kopii ustawień
const STORE_KEY = 'ailist.aimusic';
const CHECK_MS = 24 * 3600_000;
const MAX_SKIPS = 10;

interface Stored {
  version: number;
  checkedAt: number;
  ids: string[];
}

let ids: Set<string> | null = null;
let skips = 0;
let refreshing = false;

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function stored(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') as Stored | null;
    return v && Array.isArray(v.ids) && typeof v.version === 'number' ? v : null;
  } catch {
    return null;
  }
}

function loadIds(): Set<string> {
  ids ??= new Set(stored()?.ids ?? []);
  return ids;
}

export function aiListSize(): number {
  return loadIds().size;
}

export function isAiArtist(artistId: string | undefined): boolean {
  return !!artistId && loadIds().has(artistId);
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Podpisany manifest listy: bez znanego klucza i poprawnego podpisu zostaje poprzednia lista. */
export async function verifyManifest(m: {
  key_id?: string;
  payload?: string;
  sig?: string;
}): Promise<{ list: string; version: number; snapshot: { path: string; sha256: string } } | null> {
  const key = m.key_id ? KEYS[m.key_id] : undefined;
  if (!key || !m.payload || !m.sig) return null;
  const payload = b64(m.payload);
  const pub = await crypto.subtle.importKey('spki', b64(key), { name: 'Ed25519' }, false, [
    'verify',
  ]);
  if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64(m.sig), payload))) return null;
  const p = JSON.parse(new TextDecoder().decode(payload));
  return p?.list === 'aimusic' && Number.isInteger(p.version) && p.snapshot?.path ? p : null;
}

async function refresh(force = false) {
  const cur = stored();
  if (refreshing || (!force && cur && Date.now() - cur.checkedAt < CHECK_MS)) return;
  refreshing = true;
  try {
    const res = await fetch(BASE + 'manifest.json');
    if (!res.ok) return;
    const m = await verifyManifest(await res.json());
    // starsza wersja to cofnięcie listy, którego klient nie przyjmuje
    if (!m || (cur && m.version < cur.version)) return;
    if (cur && m.version === cur.version) {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...cur, checkedAt: Date.now() }));
      return;
    }
    if (!/^snapshot\/\d+\.json$/.test(m.snapshot.path)) return;
    const snap = await fetch(BASE + m.snapshot.path);
    if (!snap.ok) return;
    const bytes = new Uint8Array(await snap.arrayBuffer());
    if ((await sha256Hex(bytes)) !== m.snapshot.sha256) return;
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const list: string[] = (data?.block?.ids ?? []).filter(
      (x: unknown): x is string => typeof x === 'string' && /^UC[\w-]{22}$/.test(x)
    );
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ version: m.version, checkedAt: Date.now(), ids: list })
    );
    ids = new Set(list);
  } catch {
    // brak sieci albo zmieniony format: zostaje ostatnia dobra lista
  } finally {
    refreshing = false;
  }
}

export const skipAiMusicPlugin: ZenithPlugin = {
  id: 'skip-ai-music',
  name: 'Skip AI music',
  category: 'playback',
  description: 'Skips tracks by artists that mainly publish AI-generated music.',
  defaultEnabled: false,
  onEnable() {
    void refresh();
  },
  onDisable() {
    ids = null;
  },
  onTrackChange(info: NowPlayingInfo | null) {
    if (!info) return;
    void refresh();
    if (!isAiArtist(info.artistId)) {
      skips = 0;
      return;
    }
    skips += 1;
    if (skips <= MAX_SKIPS) skipCurrent();
  },
};
