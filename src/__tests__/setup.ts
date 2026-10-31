// Node.js 25+ (26 LTS included) exposes a global localStorage getter that
// returns undefined unless --localstorage-file is set. That shadows jsdom's
// window.localStorage when tests use the bare `localStorage` identifier.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(String(key), String(value));
    },
  };
}

function adoptWebStorage(name: 'localStorage' | 'sessionStorage') {
  const current = (globalThis as unknown as Record<string, unknown>)[name];
  if (current && typeof (current as Storage).getItem === 'function') return;

  const fromWindow =
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)[name]
      : undefined;
  const value =
    fromWindow && typeof (fromWindow as Storage).getItem === 'function'
      ? (fromWindow as Storage)
      : memoryStorage();

  try {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  } catch {
    (globalThis as unknown as Record<string, unknown>)[name] = value;
  }

  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    } catch {
      (window as unknown as Record<string, unknown>)[name] = value;
    }
  }
}

adoptWebStorage('localStorage');
adoptWebStorage('sessionStorage');
