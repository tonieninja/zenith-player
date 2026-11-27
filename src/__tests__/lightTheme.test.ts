import { describe, expect, it } from 'vitest';
import { lightColor, lightRule, lightSelector } from '../styles/lightTheme';

const channels = (c: string | null) => (c ?? '').match(/[\d.]+/g)!.map(Number);

describe('light theme generated from the dark CSS', () => {
  it('turns white text into dark ink and dark surfaces into light ones', () => {
    expect(Math.max(...channels(lightColor('#ffffff', 'text')))).toBeLessThan(40);
    expect(Math.min(...channels(lightColor('#0a0b10', 'surface')))).toBeGreaterThan(230);
    expect(channels(lightColor('rgba(255, 255, 255, 0.08)', 'surface'))[3]).toBe(0.08);
  });

  it('keeps saturated buttons and softens black shadows', () => {
    expect(lightColor('#e53935', 'surface')).toBeNull();
    expect(channels(lightColor('rgba(0, 0, 0, 0.4)', 'shadow'))[3]).toBe(0.2);
    expect(lightColor('rgba(255, 255, 255, 0.3)', 'shadow')).toBeNull();
  });

  it('scopes copies under the light root with the same specificity', () => {
    expect(lightSelector(':root')).toBe(":root:where([data-theme='light'])");
    expect(lightSelector('.a > .b')).toBe(":where(:root[data-theme='light']) .a > .b");
  });

  it('leaves variable names alone and keeps white text on the accent', () => {
    const r = lightRule(
      ['.scrim'],
      [{ prop: 'background', value: 'linear-gradient(#000, var(--rich-black-2))' }]
    );
    expect(r?.decls[0]!.value).toContain('var(--rich-black-2)');
    expect(
      lightRule(
        ['.btn'],
        [
          { prop: 'background', value: 'var(--accent-2)' },
          { prop: 'color', value: '#fff' },
        ]
      )
    ).toBeNull();
  });

  it('skips cover overlays and keyframe steps', () => {
    const decls = [{ prop: 'background', value: 'rgba(0, 0, 0, 0.5)' }];
    expect(lightRule(['.yt-card-overlay'], decls)).toBeNull();
    expect(lightRule(['50%'], decls)).toBeNull();
    expect(lightRule(['.panel'], decls)).not.toBeNull();
  });
});
