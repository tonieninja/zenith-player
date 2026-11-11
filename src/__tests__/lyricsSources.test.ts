import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import {
  base64Utf8,
  getBoidu,
  getKugou,
  getLyricsPlus,
  getNetease,
  getQQMusic,
  getUnison,
  parseTtml,
  stripCredits,
  ttmlTime,
  type SourceQuery,
} from '../lyrics/sources';
import { parseLrc, parseRichsync } from '../lyrics/parse';
import { lyricLineEnd } from '../lyrics/active';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const q: SourceQuery = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 };

beforeEach(() => {
  httpFetch.mockReset();
});

describe('lrc', () => {
  it('turns a blank stamp before a long solo into a break and keeps short pauses', () => {
    const lrc =
      '[00:10.00]before the solo\n[00:13.00]\n[00:45.00]after\n[00:47.00] \n[00:49.00]next';
    expect(parseLrc(lrc)).toEqual([
      { time: 10, text: 'before the solo' },
      { time: 13, text: '♪' },
      { time: 45, text: 'after' },
      { time: 49, text: 'next' },
    ]);
    expect(parseLrc('[00:01.00]one\n[00:02.00]two\n[00:04.00]♪')).toEqual([
      { time: 1, text: 'one' },
      { time: 2, text: 'two' },
      { time: 4, text: '♪' },
    ]);
  });

  it('joins duet lines that share a stamp and applies the offset tag', () => {
    expect(parseLrc('[offset:+500]\n[00:05.00]me\n[00:05.00]you\n[00:07.00]us')).toEqual([
      { time: 4.5, text: 'me / you' },
      { time: 6.5, text: 'us' },
    ]);
  });

  it('reads the richsync line end as the start of a break', () => {
    const body = JSON.stringify([
      { ts: 1, te: 3, x: 'first' },
      { ts: 20, te: 22, x: 'second' },
    ]);
    expect(parseRichsync(body)).toEqual([
      { time: 1, text: 'first' },
      { time: 3, text: '♪' },
      { time: 20, text: 'second' },
      { time: 22, text: '♪' },
    ]);
  });

  it('ends the karaoke fill when the line is sung, not at the next line after a solo', () => {
    const lines = [
      { time: 10, text: 'short' },
      { time: 12, text: 'a line right before a thirty second guitar solo' },
      { time: 45, text: 'back' },
    ];
    expect(lyricLineEnd(lines, 0)).toBe(12);
    expect(lyricLineEnd(lines, 1)).toBeCloseTo(12 + 47 * 0.25);
    expect(lyricLineEnd(lines, 2)).toBe(49);
  });
});

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

  it('marks the gap after a line end as an instrumental break', () => {
    const xml =
      '<tt><body><p begin="10" end="12">verse</p><p begin="40" end="42">chorus</p></body></tt>';
    expect(parseTtml(xml)).toEqual([
      { time: 10, text: 'verse' },
      { time: 12, text: '♪' },
      { time: 40, text: 'chorus' },
      { time: 42, text: '♪' },
    ]);
  });
});

describe('credits', () => {
  it('removes producer lines and the title header', () => {
    const lines = [
      { time: 0, text: 'Blinding Lights - The Weeknd' },
      { time: 1, text: '作词 : Abel Tesfaye' },
      { time: 2, text: 'Lyrics by：Max Martin' },
      { time: 3, text: 'Drums：David Stewart' },
      { time: 4, text: 'Background Vocals : Someone' },
      { time: 27, text: 'I been tryna call' },
      { time: 40, text: 'Baby: I can see' },
    ];
    expect(stripCredits(lines, 'Blinding Lights')).toEqual([
      { time: 27, text: 'I been tryna call' },
      { time: 40, text: 'Baby: I can see' },
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

describe('Boidu', () => {
  it('needs a duration and reads ttml', async () => {
    expect(await getBoidu({ title: 'x', artist: 'y' })).toBeNull();
    expect(httpFetch).not.toHaveBeenCalled();
    httpFetch.mockResolvedValue(
      json({
        ttml: '<tt><body><p begin="1.0"><span>Hello</span></p><p begin="2.5">there</p></body></tt>',
      })
    );
    expect((await getBoidu(q))?.synced).toEqual([
      { time: 1, text: 'Hello' },
      { time: 2.5, text: 'there' },
    ]);
  });

  it('treats 401 as not in the database', async () => {
    httpFetch.mockResolvedValue(json({ error: 'not cached' }, 401));
    expect(await getBoidu(q)).toBeNull();
  });

  it('rejects lyrics that run past the end of the track', async () => {
    httpFetch.mockResolvedValue(json({ lrc: '[00:10.00]one\n[04:20.00]two' }));
    expect(await getBoidu(q)).toBeNull();
  });
});

describe('Unison', () => {
  it('asks by video id first, then by name', async () => {
    httpFetch
      .mockResolvedValueOnce(json({ success: false }, 404))
      .mockResolvedValueOnce(
        json({ data: { format: 'lrc', lyrics: '[00:01.00]one\n[00:02.00]two' } })
      );
    const hit = await getUnison({ ...q, videoId: 'abcdefghijk' });
    expect(hit?.synced).toEqual([
      { time: 1, text: 'one' },
      { time: 2, text: 'two' },
    ]);
    expect(String(httpFetch.mock.calls[0][0])).toContain('v=abcdefghijk');
    expect(String(httpFetch.mock.calls[1][0])).toContain('song=Blinding%20Lights');
  });

  it('keeps plain lyrics plain', async () => {
    httpFetch.mockResolvedValue(json({ data: { format: 'plain', lyrics: 'just words' } }));
    expect(await getUnison(q)).toEqual({ text: 'just words' });
  });

  it('checks the song a name search returns, but trusts lyrics filed under the video', async () => {
    const other = { song: 'Save Your Tears', artist: 'The Weeknd', format: 'plain', lyrics: 'x' };
    httpFetch.mockResolvedValue(json({ data: other }));
    expect(await getUnison(q)).toBeNull();
    expect(await getUnison({ ...q, videoId: 'abcdefghijk' })).toEqual({ text: 'x' });
    httpFetch.mockResolvedValue(json({ data: { ...other, song: 'Blinding Lights' } }));
    expect((await getUnison(q))?.score).toBeGreaterThan(0);
  });
});

describe('Netease', () => {
  it('skips a match without lyrics and strips credits', async () => {
    httpFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('search/get')) {
        expect(init?.body).toContain('s=Blinding%20Lights%20The%20Weeknd');
        return json({
          result: {
            songs: [
              {
                id: 1,
                name: 'Blinding Lights',
                artists: [{ name: 'The Weeknd' }],
                duration: 200045,
              },
              {
                id: 2,
                name: 'Blinding Lights',
                artists: [{ name: 'The Weeknd' }],
                duration: 201000,
              },
              { id: 3, name: 'Some Other Song', artists: [{ name: 'Nobody' }], duration: 90000 },
            ],
          },
        });
      }
      if (u.includes('id=1')) return json({ lrc: { lyric: '' } });
      return json({
        lrc: { lyric: '[00:00.00] 作词 : Abel\n[00:27.39]I been tryna call\n[00:30.18]On my own' },
      });
    });
    const hit = await getNetease(q);
    expect(hit?.synced).toEqual([
      { time: 27.39, text: 'I been tryna call' },
      { time: 30.18, text: 'On my own' },
    ]);
    expect(httpFetch.mock.calls.some((c) => String(c[0]).includes('id=3'))).toBe(false);
  });

  it('does not take synced lyrics from a cut of another length', async () => {
    httpFetch.mockResolvedValue(
      json({
        result: {
          songs: [
            { id: 7, name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], dt: 262000 },
          ],
        },
      })
    );
    expect(await getNetease(q)).toBeNull();
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });
});

describe('QQ Music', () => {
  it('looks up durations, then lyrics, base64 or not', async () => {
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('smartbox')) {
        return json({ data: { song: { itemlist: [{ mid: 'aaa' }, { mid: 'bbb' }] } } });
      }
      if (u.includes('play_single_song')) {
        expect(u).toContain('songmid=aaa%2Cbbb');
        return json({
          data: [
            {
              mid: 'aaa',
              name: 'Blinding Lights',
              singer: [{ name: 'The Weeknd' }],
              interval: 261,
            },
            {
              mid: 'bbb',
              name: 'Blinding Lights',
              singer: [{ name: 'The Weeknd' }],
              interval: 200,
            },
          ],
        });
      }
      expect(u).toContain('songmid=bbb');
      const lrc = '[00:04.69]Lyrics by：Abel\n[00:27.39]I been tryna call\n[00:30.18]On my own';
      return json({ lyric: btoa(String.fromCharCode(...new TextEncoder().encode(lrc))) });
    });
    expect((await getQQMusic(q))?.synced).toEqual([
      { time: 27.39, text: 'I been tryna call' },
      { time: 30.18, text: 'On my own' },
    ]);
  });
});

describe('Kugou', () => {
  it('retries an empty search, then follows hash, candidate and download', async () => {
    let searches = 0;
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('song_search_v2')) {
        searches += 1;
        if (searches === 1) return json({ data: { lists: [] } });
        return json({
          data: {
            lists: [
              {
                SongName: '<em>Blinding Lights</em>',
                SingerName: 'The Weeknd',
                Duration: 200,
                FileHash: 'ABC123',
              },
            ],
          },
        });
      }
      if (u.includes('krcs.kugou.com')) {
        expect(u).toContain('hash=ABC123');
        return json({ candidates: [{ id: '42', accesskey: 'KEY' }] });
      }
      expect(u).toContain('accesskey=KEY');
      return json({ content: btoa('[00:27.39]I been tryna call\n[00:30.18]On my own') });
    });
    expect((await getKugou(q))?.synced).toEqual([
      { time: 27.39, text: 'I been tryna call' },
      { time: 30.18, text: 'On my own' },
    ]);
    expect(searches).toBe(2);
  });
});
