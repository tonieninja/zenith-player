export function normalizePluginSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function pluginQueryMatches(haystacks: string[], query: string): boolean {
  const q = normalizePluginSearch(query);
  if (!q) return true;
  return haystacks.some((s) => normalizePluginSearch(s).includes(q));
}
