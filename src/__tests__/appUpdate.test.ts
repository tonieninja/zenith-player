import { describe, expect, it } from 'vitest';
import { classifyRelease } from '../utils/appUpdate';
import { translations } from '../i18n';

describe('release comparison', () => {
  it('a local build ahead of the published tag is not "you are on that tag"', () => {
    expect(classifyRelease('4.0.1', 'v4.0.0')).toBe('ahead');
    expect(classifyRelease('4.0.1', '4.0.1')).toBe('current');
    expect(classifyRelease('4.0.1', 'v4.0.2')).toBe('newer');
  });

  it('the ahead message is translated', () => {
    expect(translations.pl.updateAhead).not.toBe(translations.en.updateAhead);
    expect(translations.pl.updateAhead).toContain('{current}');
    expect(translations.pl.updateAhead).toContain('{tag}');
    expect(translations.pl.updateAvailableTag).not.toBe(translations.en.updateAvailableTag);
  });
});
