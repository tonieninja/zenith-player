import { describe, expect, it, vi } from 'vitest';
import page from './fixtures/ytm/artist_daft_punk.json';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => JSON.stringify(page)),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

const { getArtistPage, parseArtistHeader } = await import('../api/youtube');

describe('artist page header', () => {
  it('reads name, counts, banner and play endpoints', () => {
    const h = parseArtistHeader(page)!;
    expect(h.name).toBe('Daft Punk');
    expect(h.subscribers).toBe('7.22M');
    expect(h.listeners).toBe('65.2M monthly audience');
    expect(h.description).not.toBe('');
    expect(h.songsId).toBe('VLOLAK5uy_lNVBcjNtiCwq-n95uoxJ-Gd4vsfMkyZNs');
    expect(h.songsTitle).toBe('Top songs');
    expect(h.radioId).toMatch(/^RDEM/);
    expect(h.shuffleId).toMatch(/^RDAO/);
    expect(h.banner).toMatch(/^https:\/\//);
    expect(h.banner).toContain('=w1080-h450');
  });

  it('picks the widest banner up to 1920 px', () => {
    const copy = structuredClone(page) as any;
    const thumbs =
      copy.header.musicImmersiveHeaderRenderer.thumbnail.musicThumbnailRenderer.thumbnail;
    thumbs.thumbnails = [2880, 540, 1920, 1440].map((w) => ({ url: `https://x/=w${w}`, width: w }));
    expect(parseArtistHeader(copy)?.banner).toBe('https://x/=w1920');
  });

  it('returns null without an artist header', () => {
    expect(parseArtistHeader({ header: {} })).toBeNull();
    expect(parseArtistHeader(null)).toBeNull();
  });

  it('has no songs list when the shelf has no "show all" link', () => {
    const copy = structuredClone(page) as any;
    const shelf =
      copy.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
        .sectionListRenderer.contents[0].musicShelfRenderer;
    delete shelf.bottomEndpoint;
    delete shelf.title.runs[0].navigationEndpoint;
    expect(parseArtistHeader(copy)?.songsId).toBeNull();
  });

  it('keeps the top songs section under the header title', async () => {
    const res = await getArtistPage('UC_kRDKYrUlrbtrSiyu5Tflg', 'en');
    const top = res.sections.find((s) => s.title === res.header?.songsTitle);
    expect(top?.items).toHaveLength(5);
    expect(top?.items.every((i) => i.type === 'track')).toBe(true);
    expect(res.sections.length).toBeGreaterThan(1);
  });
});
