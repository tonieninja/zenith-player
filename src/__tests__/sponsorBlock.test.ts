import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import {
  parseSegments,
  resetSponsorBlockForTests,
  sponsorBlockJump,
  sponsorBlockPlugin,
} from '../plugins/sponsorBlock';

const ID = 'dQw4w9WgXcQ';
const flush = () => new Promise((r) => setTimeout(r, 0));

function reply(segments: unknown[], status = 200, videoID = ID) {
  httpFetch.mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    json: async () => [
      { videoID: 'otherVideo1', segments: [{ segment: [0, 50] }] },
      { videoID, segments },
    ],
  });
}

const seg = (start: number, end: number, extra: Record<string, unknown> = {}) => ({
  segment: [start, end],
  category: 'music_offtopic',
  actionType: 'skip',
  videoDuration: 200,
  ...extra,
});

async function primed(segments: unknown[], d = 200) {
  reply(segments);
  expect(sponsorBlockJump(ID, 1, d)).toBeNull();
  await flush();
  await flush();
}

describe('SponsorBlock', () => {
  beforeEach(() => {
    httpFetch.mockReset();
    resetSponsorBlockForTests();
  });

  it('asks only with a 4 character hash prefix and the music categories', async () => {
    await primed([]);
    const url = String(httpFetch.mock.calls[0][0]);
    expect(url).toContain('/api/skipSegments/5f6b?');
    expect(url).toContain('actionType=skip');
    expect(decodeURIComponent(url)).toContain('"music_offtopic"');
    expect(url).not.toContain(ID);
  });

  it('jumps to the end of a segment and ignores other videos in the reply', async () => {
    await primed([seg(10, 30)]);
    expect(sponsorBlockJump(ID, 5, 200)).toBeNull();
    expect(sponsorBlockJump(ID, 12, 200)).toBe(30);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('lands just before the end when the segment runs to the end of the track', async () => {
    await primed([seg(180, 199.6)]);
    expect(sponsorBlockJump(ID, 181, 200)).toBeCloseTo(199.75);
  });

  it('never skips a whole track or a segment marked on another cut', async () => {
    await primed([seg(0, 195), seg(40, 60, { videoDuration: 260 })]);
    expect(sponsorBlockJump(ID, 10, 200)).toBeNull();
    expect(sponsorBlockJump(ID, 45, 200)).toBeNull();
  });

  it('treats 404 as no segments', async () => {
    reply([], 404);
    sponsorBlockJump(ID, 1, 200);
    await flush();
    expect(sponsorBlockJump(ID, 12, 200)).toBeNull();
  });

  it('lets the user listen to a segment after seeking back into it', async () => {
    await primed([seg(10, 30)]);
    const jump = sponsorBlockJump(ID, 12, 200);
    sponsorBlockPlugin.onSeek?.(jump!);
    expect(sponsorBlockJump(ID, 13, 200)).toBe(30);
    sponsorBlockPlugin.onSeek?.(15);
    expect(sponsorBlockJump(ID, 16, 200)).toBeNull();
  });

  it('drops mute and highlight actions, unknown categories and tiny segments', () => {
    const got = parseSegments(
      [
        {
          videoID: ID,
          segments: [
            seg(1, 5, { actionType: 'mute' }),
            seg(1, 5, { category: 'poi_highlight' }),
            seg(1, 1.3),
            seg(8, 20, { category: 'sponsor' }),
          ],
        },
      ],
      ID
    );
    expect(got).toEqual([{ start: 8, end: 20, videoDuration: 200 }]);
  });
});
