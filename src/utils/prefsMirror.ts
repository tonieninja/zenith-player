import { invoke } from '@tauri-apps/api/core';

const MAX_VALUE = 4096;
const SECRET = /token|secret|session|password|apikey|api_key|cookie/i;
let timer: number | undefined;

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('zenith') || SECRET.test(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null && v.length <= MAX_VALUE) out[k] = v;
  }
  return out;
}

function scheduleSave() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    void invoke('prefs_save', { prefs: snapshot() }).catch(() => {});
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
    if (this === localStorage && k.startsWith('zenith')) scheduleSave();
  };
  proto.removeItem = function (this: Storage, k: string) {
    remove.call(this, k);
    if (this === localStorage && k.startsWith('zenith')) scheduleSave();
  };
  scheduleSave();
}
