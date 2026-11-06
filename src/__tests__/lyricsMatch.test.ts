import { describe, expect, it } from 'vitest';
import {
  isAcceptableLyricsMatch,
  pickBestSyncedLyrics,
  scoreLyricsMatch,
  shouldShowEarlyPlain,
} from '../utils/lyricsMatch';
import {
  collectMusixmatchBundleUrls,
  extractMusixmatchSecretFromJs,
  geniusHttpError,
  MXM_SECRET_MISSING,
} from '../utils/lyricsProviders';
import { localizeLyricsReason } from '../utils/lyricsReasons';

const lucky = { title: 'Get Lucky', artist: 'Daft Punk' };
const around = { title: 'Around the World', artist: 'Daft Punk' };

describe('lyrics title/artist/duration matching', () => {
  it('rejects Get Lucky matched to NOKIA', () => {
    const cand = { title: 'NOKIA', artist: 'Drake' };
    expect(isAcceptableLyricsMatch(lucky, cand)).toBe(false);
    expect(scoreLyricsMatch(lucky, cand)).toBeLessThan(8);
  });

  it('rejects another song by the same artist (One More Time)', () => {
    expect(isAcceptableLyricsMatch(lucky, { title: 'One More Time', artist: 'Daft Punk' })).toBe(
      false
    );
  });

  it('rejects a same-title song by a different artist (no duration)', () => {
    expect(
      isAcceptableLyricsMatch(around, { title: 'Around the World', artist: 'Aqua Timez' })
    ).toBe(false);
  });

  it('accepts the real Get Lucky / Daft Punk match', () => {
    expect(isAcceptableLyricsMatch(lucky, { title: 'Get Lucky', artist: 'Daft Punk' })).toBe(true);
    expect(
      isAcceptableLyricsMatch(lucky, {
        title: 'Get Lucky (feat. Pharrell Williams)',
        artist: 'Daft Punk',
      })
    ).toBe(true);
  });

  it('uses duration to accept an exact title when the artist string is missing', () => {
    expect(
      isAcceptableLyricsMatch(
        { title: 'Around the World', artist: 'Daft Punk', durationSec: 429 },
        { title: 'Around the World', artist: '', durationSec: 430 }
      )
    ).toBe(true);
  });

  it('rejects a large duration mismatch even with the same title', () => {
    expect(
      isAcceptableLyricsMatch(
        { title: 'Around the World', artist: 'Daft Punk', durationSec: 429 },
        { title: 'Around the World', artist: 'Cover Band', durationSec: 180 }
      )
    ).toBe(false);
  });

  it('treats Polish diacritics as the same letters when scoring', () => {
    expect(
      isAcceptableLyricsMatch(
        { title: 'Wehikuł czasu', artist: 'Dżem' },
        { title: 'Wehikul czasu', artist: 'Dzem' }
      )
    ).toBe(true);
    expect(
      scoreLyricsMatch(
        { title: 'Wehikuł czasu', artist: 'Dżem' },
        { title: 'Wehikul czasu', artist: 'Dzem' }
      )
    ).toBeGreaterThanOrEqual(15);
  });

  it('rejects a Get Lucky hit whose duration is NOKIA-length', () => {
    expect(
      isAcceptableLyricsMatch(
        { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 248 },
        { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 221 }
      )
    ).toBe(true);
    expect(
      isAcceptableLyricsMatch(
        { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 369 },
        { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 221 }
      )
    ).toBe(false);
  });
});

describe('Auto lyrics display rules', () => {
  it('prefers LRCLib synced lyrics when match scores are equal', () => {
    const lrclib = { provider: 'LRCLib', matchScore: 15, synced: { length: 40 } };
    const mxm = { provider: 'Musixmatch', matchScore: 15, synced: { length: 42 } };
    expect(pickBestSyncedLyrics([mxm, lrclib])?.provider).toBe('LRCLib');
  });

  it('does not early-show Lyrics.ovh plain text', () => {
    expect(
      shouldShowEarlyPlain({ provider: 'Lyrics.ovh', text: 'wrong song lyrics', matchScore: 0 })
    ).toBe(false);
  });

  it('allows verified plain text and YouTube Music', () => {
    expect(
      shouldShowEarlyPlain({
        provider: 'Musixmatch',
        text: 'like the legend of the phoenix',
        matchScore: 15,
      })
    ).toBe(true);
    expect(shouldShowEarlyPlain({ provider: 'YouTube Music', text: 'around the world' })).toBe(
      true
    );
  });
});

describe('Musixmatch secret extraction and Genius 403', () => {
  it('finds hashed turbopack chunks instead of only pages/_app', () => {
    const html = `
      <script src="https://s.mxmcdn.net/mxm-com/prod/1.43.0/_next/static/chunks/0a3swv2oz8k_v.js"></script>
      <script src="/_next/static/chunks/pages/_app-legacy.js"></script>
      <script src="https://s.mxmcdn.net/mxm-com/prod/1.43.0/_next/static/chunks/turbopack-x.js"></script>
    `;
    const urls = collectMusixmatchBundleUrls(html);
    expect(urls[0]).toContain('pages/_app-legacy.js');
    expect(urls.some((u) => u.includes('0a3swv2oz8k_v.js'))).toBe(true);
    expect(urls.findIndex((u) => u.includes('0a3swv2oz8k_v'))).toBeLessThan(
      urls.findIndex((u) => u.includes('turbopack'))
    );
  });

  it('decodes the reversed-base64 from() secret used by the community API', () => {
    const secret = 'community-secret';
    const payload = btoa(secret).split('').reverse().join('');
    const js = `const x = from("${payload}".split("").reverse().join(""));`;
    expect(extractMusixmatchSecretFromJs(js)).toBe(secret);
    expect(extractMusixmatchSecretFromJs('no secret here')).toBeNull();
    const bufferJs = `u=i.Buffer.from("${payload}".split("").reverse().join(""),"base64").toString()`;
    expect(extractMusixmatchSecretFromJs(bufferJs)).toBe(secret);
  });

  it('explains Genius 403 and a missing Musixmatch signature in both languages', () => {
    const g = geniusHttpError(403, 'search');
    expect(g).toMatch(/HTTP 403/);
    expect(g).toMatch(/another lyrics provider/);
    expect(localizeLyricsReason(g, 'en')).toMatch(/403/);
    expect(localizeLyricsReason(g, 'pl')).toMatch(/403/);
    expect(localizeLyricsReason(MXM_SECRET_MISSING, 'pl')).toMatch(/Musixmatch/);
    expect(localizeLyricsReason('Musixmatch timed out after 22s', 'en')).toBe(
      'Timed out after 22 s'
    );
    expect(localizeLyricsReason('Musixmatch timed out after 8s', 'pl')).toMatch(/8/);

    expect(
      localizeLyricsReason('Signature secret not found in Musixmatch app bundle', 'en')
    ).toMatch(/signing secret/i);
  });
});
