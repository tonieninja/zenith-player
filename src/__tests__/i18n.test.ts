import { describe, expect, it } from 'vitest';
import { translations } from '../i18n';
import { lastfmErrorText } from '../utils/lastfmErrors';

const en = translations.en as unknown as Record<string, string>;
const pl = translations.pl as unknown as Record<string, string>;

describe('translations', () => {
  it('every key has a non-empty text in both languages', () => {
    for (const k of Object.keys(en)) {
      expect(en[k]?.trim(), `en.${k}`).toBeTruthy();
      expect(pl[k]?.trim(), `pl.${k}`).toBeTruthy();
    }
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
