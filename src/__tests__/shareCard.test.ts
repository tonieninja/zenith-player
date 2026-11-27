import { describe, expect, it } from 'vitest';
import { fitLine, wrapText } from '../plugins/shareCard';

// 10 px na znak wystarcza, żeby sprawdzić łamanie bez prawdziwego canvasa
function fakeCtx() {
  const drawn: [string, number][] = [];
  return {
    drawn,
    measureText: (t: string) => ({ width: t.length * 10 }) as TextMetrics,
    fillText: (t: string, _x: number, y: number) => void drawn.push([t, y]),
  };
}

describe('share card text', () => {
  it('keeps a short title on one line', () => {
    const ctx = fakeCtx();
    expect(wrapText(ctx, 'Krótki tytuł', 0, 700, 300, 60, 2)).toBe(700);
    expect(ctx.drawn).toEqual([['Krótki tytuł', 700]]);
  });

  it('stops at two lines and ends the second with an ellipsis', () => {
    const ctx = fakeCtx();
    const last = wrapText(ctx, 'aaaa bbbb cccc dddd eeee ffff', 0, 700, 100, 60, 2);
    expect(last).toBe(760);
    expect(ctx.drawn).toEqual([
      ['aaaa bbbb', 700],
      ['cccc dddd…', 760],
    ]);
    expect(ctx.drawn.every(([t]) => t.length * 10 <= 100)).toBe(true);
  });

  it('shortens a single word wider than the card', () => {
    expect(fitLine(fakeCtx(), 'x'.repeat(30), 100)).toBe(`${'x'.repeat(9)}…`);
  });
});
