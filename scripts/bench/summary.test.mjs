import { describe, expect, it } from 'vitest';
import { median, parseCsv, slopePerHour, summarize } from './summary.mjs';

const HEAD = 'time,elapsed_s,processes,ws_private_mb,cpu_pct,handles';

// co 10 minut przez 4 h; pamięć rośnie o mbPerHour, uchwyty stoją, a pierwsze pół godziny to rozgrzewka
function csv(mbPerHour) {
  const lines = [HEAD];
  for (let s = 600; s <= 4 * 3600; s += 600) {
    const warm = s < 1800 ? 200 : 0;
    const mb = 300 + warm + (mbPerHour * s) / 3600;
    lines.push(`t,${s},6,${mb},1.5,${s % 1200 ? 900 : 910}`);
  }
  return lines.join('\r\n') + '\r\n';
}

describe('bench summary', () => {
  it('takes the median of odd and even lists', () => {
    expect(median([1, 2, 9])).toBe(2);
    expect(median([1, 2, 4, 9])).toBe(3);
  });

  it('gives the slope per hour from seconds', () => {
    const xs = [0, 1800, 3600, 7200];
    expect(slopePerHour(xs, [5, 6, 7, 9])).toBeCloseTo(2);
    expect(slopePerHour(xs, [4, 4, 4, 4])).toBe(0);
    expect(slopePerHour([10], [1])).toBeNaN();
  });

  it('parses CRLF files', () => {
    const { cols, rows } = parseCsv(csv(0));
    expect(cols).toEqual(HEAD.split(','));
    expect(rows).toHaveLength(24);
    expect(rows[0].handles).toBe('900');
  });

  it('flags growth over the limit once the warm-up is skipped', () => {
    const s = summarize(csv(12), { skipMin: 30 });
    const ws = s.series.find((r) => r.col === 'ws_private_mb');
    expect(ws.slope).toBeCloseTo(12);
    expect(ws.min).toBeCloseTo(306);
    expect(ws.max).toBeCloseTo(348);
    expect(ws.leak).toBe(true);
    expect(s.series.find((r) => r.col === 'handles').leak).toBe(false);
    expect(s.leak).toBe(true);
    expect(s.samples).toBe(22);
  });

  it('passes a flat run and lets the warm-up fool an unskipped one', () => {
    expect(summarize(csv(0), { skipMin: 30 }).leak).toBe(false);
    const ws = summarize(csv(0)).series.find((r) => r.col === 'ws_private_mb');
    expect(ws.slope).toBeLessThan(0);
  });

  it('counts samples without the app, warm-up included', () => {
    const text = `${HEAD}\nt,0,0,,,\nt,3600,6,110,2,1\nt,7200,0,,,\nt,9000,6,120,4,1\n`;
    expect(summarize(text, { skipMin: 30 }).gone).toBe(2);
    expect(summarize(csv(0)).gone).toBe(0);
  });

  it('ignores empty cells instead of reading them as zero', () => {
    const text = `${HEAD}\nt,0,6,100,,1\nt,3600,6,110,2,1\nt,7200,6,120,4,1\n`;
    const cpu = summarize(text).series.find((r) => r.col === 'cpu_pct');
    expect(cpu.min).toBe(2);
    expect(cpu.median).toBe(3);
  });
});
