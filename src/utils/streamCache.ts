/** lru for stream urls, kick the oldest instead of wiping everything */
export function streamCacheSet(
  cache: Map<string, { url: string; ts: number }>,
  id: string,
  url: string,
  limit: number
) {
  if (cache.has(id)) cache.delete(id);
  cache.set(id, { url, ts: Date.now() });
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}
