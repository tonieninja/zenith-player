import { useSyncExternalStore } from 'react';

export interface StoredFlag {
  get(): boolean;
  set(on: boolean): void;
  useValue(): boolean;
}

export function storedFlag(
  key: string,
  fallback: () => boolean = () => false,
  watchFallback?: (cb: () => void) => () => void
): StoredFlag {
  const listeners = new Set<() => void>();
  const read = () => {
    const v = localStorage.getItem(key);
    return v === null ? null : v === '1';
  };
  let current = read();
  // bez zapisu liczy się bieżący fallback, bo może się zmienić w trakcie działania
  const get = () => current ?? fallback();

  // storage łapie przełączenie z innego okna (nakładka, drugi ekran, mini odtwarzacz)
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      current = read();
      cb();
    };
    window.addEventListener('storage', onStorage);
    const unwatch = watchFallback?.(cb);
    return () => {
      listeners.delete(cb);
      window.removeEventListener('storage', onStorage);
      unwatch?.();
    };
  };

  return {
    get,
    set(on) {
      current = on;
      localStorage.setItem(key, on ? '1' : '0');
      for (const l of listeners) l();
    },
    useValue: () => useSyncExternalStore(subscribe, get, () => false),
  };
}
