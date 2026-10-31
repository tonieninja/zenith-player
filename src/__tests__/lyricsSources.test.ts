import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import {
  base64Utf8,
  getLyricsPlus,
  parseTtml,
  stripCredits,
  ttmlTime,
  type SourceQuery,
} from '../lyrics/sources';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const q: SourceQuery = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 };

beforeEach(() => httpFetch.mockReset());

describe('ttml', () => {
  it('reads every time format', () => {
    expect(ttmlTime('27.395')).toBeCloseTo(27.395);
    expect(ttmlTime('27.395s')).toBeCloseTo(27.395);
    expect(ttmlTime('3:21.570')).toBeCloseTo(201.57);
    expect(ttmlTime('0:01:02.5')).toBeCloseTo(62.5);
    expect(ttmlTime('x')).toBeNull();
  });

  it('joins word spans into lines and drops background vocals', () => {
    const xml =
      '<tt><body><div><p begin="27.395" end="28.9"><span begin="27.395">I</span> <span begin="27.5">been</span></p>' +
      '<p begin="30.1"><span>e</span><span>nough</span> <span ttm:role="x-bg"><span>(ooh)</span></span> &amp; more</p>' +
      '<p begin="31">  </p></div></body></tt>';
    expect(parseTtml(xml)).toEqual([
      { time: 27.395, text: 'I been' },
      { time: 30.1, text: 'enough & more' },
    ]);
  });
});

describe('credits', () => {
  it('removes producer lines and the title header', () => {
    const lines = [
      { time: 0, text: 'Blinding Lights - The Weeknd' },
      { time: 1, text: '作词 : Abel Tesfaye' },
      { time: 2, text: 'Lyrics by：Max Martin' },
      { time: 27, text: 'I been tryna call' },
    ];
    expect(stripCredits(lines, 'Blinding Lights')).toEqual([
      { time: 27, text: 'I been tryna call' },
    ]);
  });

  it('decodes utf-8 base64', () => {
    expect(
      base64Utf8(btoa(String.fromCharCode(...new TextEncoder().encode('[00:01.00]你好'))))
    ).toBe('[00:01.00]你好');
  });
});

describe('LyricsPlus', () => {
  it('turns millisecond lines into synced lyrics', async () => {
    httpFetch.mockResolvedValue(
      json({
        type: 'Word',
        metadata: { title: 'Blinding Lights' },
        lyrics: [
          { time: 27395, duration: 1565, text: 'I been tryna call' },
          { time: 30189, duration: 2340, text: "I've been on my own for long enough" },
        ],
      })
    );
    const hit = await getLyricsPlus(q);
    expect(hit?.synced).toEqual([
      { time: 27.395, text: 'I been tryna call' },
      { time: 30.189, text: "I've been on my own for long enough" },
    ]);
    expect(String(httpFetch.mock.calls[0][0])).toContain('duration=200');
  });

  it('rejects a different song and treats 404 as no lyrics', async () => {
    httpFetch.mockResolvedValueOnce(
      json({
        type: 'Line',
        metadata: { title: 'Totally Other Song' },
        lyrics: [{ time: 1, text: 'x' }],
      })
    );
    expect(await getLyricsPlus(q)).toBeNull();
    httpFetch.mockResolvedValueOnce(json({ error: 'nope' }, 404));
    expect(await getLyricsPlus(q)).toBeNull();
    httpFetch.mockResolvedValueOnce(json({}, 500));
    await expect(getLyricsPlus(q)).rejects.toThrow('LyricsPlus HTTP 500');
  });
});
