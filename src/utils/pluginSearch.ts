export function normalizePluginSearch(value: string): string {
  return (
    value
      .toLowerCase()
      // „ł” nie rozkłada się w NFKD, a „wylacznik” bez polskich liter ma znaleźć „Wyłącznik”
      .replace(/ł/g, 'l')
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '')
  );
}

export function pluginQueryMatches(haystacks: string[], query: string): boolean {
  const q = normalizePluginSearch(query);
  if (!q) return true;
  return haystacks.some((s) => normalizePluginSearch(s).includes(q));
}
