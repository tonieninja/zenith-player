export const LIBRARY_INITIAL_PAGES = 2;
export const LIBRARY_BACKGROUND_PAGES = 40;

export type PageFetcher = (
  token: string
) => Promise<{ items: { id: string }[]; next: string | null }>;

export async function fillPages<T extends { id: string }>(opts: {
  initial: T[];
  token: string | null | undefined;
  maxPages: number;
  fetchPage: (token: string) => Promise<{ items: T[]; next: string | null }>;
}): Promise<{ items: T[]; next: string | null; pagesFetched: number }> {
  const seen = new Set(opts.initial.map((i) => i.id));
  const items = opts.initial.slice();
  let token = opts.token ?? null;
  let pagesFetched = 0;
  for (; token && pagesFetched < opts.maxPages; pagesFetched += 1) {
    try {
      const page = await opts.fetchPage(token);
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
      token = page.next && page.next !== token ? page.next : null;
    } catch {
      token = null;
      break;
    }
  }
  return { items, next: token, pagesFetched };
}
