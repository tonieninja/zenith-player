import { invoke } from '@tauri-apps/api/core';

const MAX_VALUE = 4096;
const SECRET = /token|secret|session|password|apikey|api_key|cookie|_pin$|webhook_url/i;
// pozycja w utworze zmienia się co 12 s, a bez kolejki (większej niż limit) i tak niczego nie przywraca
const SKIP = 'zenith_queue_pos';
// statystyki zrzucane co 15 s jadą do pliku przy najbliższej innej zmianie, bez własnego zapisu na dysk
const NO_TRIGGER = 'zenith_listen_stats';
let timer: number | undefined;
let lastBody = '';

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('zenith') || SECRET.test(k) || k === SKIP) continue;
    const v = localStorage.getItem(k);
    if (v != null && v.length <= MAX_VALUE) out[k] = v;
  }
  return out;
}

function scheduleSave() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    const prefs = snapshot();
    const body = JSON.stringify(prefs);
    if (body === lastBody) return;
    lastBody = body;
    void invoke('prefs_save', { prefs });
  }, 1000);
}

export async function initPrefsMirror(): Promise<void> {
  try {
    const saved = await invoke<Record<string, string>>('prefs_load');
    for (const [k, v] of Object.entries(saved || {})) {
      if (SECRET.test(k)) continue;
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch {
    return;
  }
  const proto = Storage.prototype;
  const set = proto.setItem;
  const remove = proto.removeItem;
  proto.setItem = function (this: Storage, k: string, v: string) {
    set.call(this, k, v);
    if (this !== localStorage || !k.startsWith('zenith') || SECRET.test(k) || k === SKIP) return;
    if (k !== NO_TRIGGER && String(v).length <= MAX_VALUE) scheduleSave();
  };
  proto.removeItem = function (this: Storage, k: string) {
    remove.call(this, k);
    if (this === localStorage && k.startsWith('zenith')) scheduleSave();
  };
  scheduleSave();
}
