import { describe, expect, it } from 'vitest';
import { translations } from '../i18n';
import { lastfmErrorText } from '../utils/lastfmErrors';
import { getRemotePairMode, setRemotePairMode } from '../plugins/remoteControl';
import { normGainDb } from '../audio/webFx';

const en = translations.en as unknown as Record<string, string>;
const pl = translations.pl as unknown as Record<string, string>;

describe('translations', () => {
  it('every key has a non-empty text in both languages', () => {
    for (const k of Object.keys(en)) {
      expect(en[k]?.trim(), `en.${k}`).toBeTruthy();
      expect(pl[k]?.trim(), `pl.${k}`).toBeTruthy();
    }
  });
  it('ui text sticks to plain dashes', () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(pl)])
      expect(v.includes('\u2014'), k).toBe(false);
  });
});

describe('last.fm errors', () => {
  it('maps known codes and messages to sentences, keeps unknown raw text', () => {
    expect(lastfmErrorText('last.fm 14: Unauthorized Token', en)).toBe(en.lfmErrNotApproved);
    expect(lastfmErrorText('last.fm 10: Invalid API key', pl)).toBe(pl.lfmErrKey);
    expect(lastfmErrorText('API key and shared secret are 32 hex characters each', en)).toBe(
      en.lfmErrFormat
    );
    expect(lastfmErrorText('error sending request for url', en)).toBe(en.lfmErrNetwork);
    expect(lastfmErrorText('last.fm 99: weird', en)).toContain('weird');
  });
});

describe('remote pairing default', () => {
  it('is on for a fresh profile and remembers an explicit off', () => {
    localStorage.removeItem('zenith_remote_pair');
    expect(getRemotePairMode()).toBe(true);
    setRemotePairMode(false);
    expect(getRemotePairMode()).toBe(false);
    setRemotePairMode(true);
    expect(getRemotePairMode()).toBe(true);
  });
});

describe('loudness normalization', () => {
  it('needs a few blocks, only cuts, never boosts, and caps the cut', () => {
    expect(normGainDb(1, 2)).toBeNull();
    expect(normGainDb(5 * 1e-3, 5)).toBe(0);
    expect(normGainDb(5 * 1, 5)).toBe(-10);
  });
});
