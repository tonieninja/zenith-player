import { describe, expect, it } from 'vitest';
import { parseTranslations } from '../lyrics/extras';
import { storedFlag } from '../lyrics/flag';
import { romanizeCyrillic, romanizeLines } from '../lyrics/romanize';

describe('stored flag', () => {
  it('follows a changing fallback until something is saved', () => {
    localStorage.removeItem('zenith_test_flag');
    let sys = true;
    const flag = storedFlag('zenith_test_flag', () => sys);
    expect(flag.get()).toBe(true);
    sys = false;
    expect(flag.get()).toBe(false);
    flag.set(true);
    expect(flag.get()).toBe(true);
    localStorage.removeItem('zenith_test_flag');
  });
});

describe('lyrics romanization', () => {
  it('romanizes korean, chinese and cyrillic lines and skips latin ones', async () => {
    const out = await romanizeLines(['사랑해요', '我爱你 hello', 'Я тебя люблю', 'just english']);
    expect(out[0]).toBe('saranghaeyo');
    expect(out[1]).toBe('wǒ ài nǐ hello');
    expect(out[2]).toBe('Ya tebya lyublyu');
    expect(out[3]).toBeUndefined();
  });

  it('keeps case and drops soft signs in cyrillic', () => {
    expect(romanizeCyrillic('Щастя, Київ')).toBe('Shchastya, Kiyiv');
    expect(romanizeCyrillic('Мальчик')).toBe('Malchik');
  });
});

describe('lyrics translation', () => {
  it('reads translations with and without detected language', () => {
    expect(parseTranslations([['kocham cię', 'ko'], 'witam'], 2)).toEqual([
      ['kocham cię', 'ko'],
      ['witam', null],
    ]);
    expect(parseTranslations([['a', 'en']], 2)).toBeNull();
  });
});
