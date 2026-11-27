const KEY = 'zenith_search_history';
const LIMIT = 10;

export function loadSearchHistory(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list)
      ? list.filter((q) => typeof q === 'string' && q).slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

function save(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // pełny localStorage: historia jest tylko podpowiedzią, lista w pamięci wystarczy do końca sesji
  }
  return list;
}

/** Wpisuje zapytanie na początek listy; to samo inną wielkością liter nie robi drugiego wpisu. */
export function addSearchHistory(query: string): string[] {
  const q = query.trim();
  if (!q) return loadSearchHistory();
  const lower = q.toLowerCase();
  return save([q, ...loadSearchHistory().filter((x) => x.toLowerCase() !== lower)].slice(0, LIMIT));
}

export function removeSearchHistory(query: string): string[] {
  return save(loadSearchHistory().filter((x) => x !== query));
}
