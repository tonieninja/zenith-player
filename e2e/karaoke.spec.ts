import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

// the karaoke wipe on a line that wraps onto two rows must run row by row: the second row
// stays dim while the first fills, then fills itself. checked for both wipe engines:
// columns (WebKitGTK / Linux UA) and composited transforms (WebView2 / Windows UA)
const dist = join(process.cwd(), 'e2e', 'harness', 'dist');
let server: Server;
let base = '';

test.beforeAll(async () => {
  execSync('npx vite build --config e2e/harness/vite.config.ts', { stdio: 'inherit' });
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
  };
  server = createServer((req, res) => {
    const f = join(dist, decodeURIComponent((req.url || '/').split('?')[0]));
    if (!f.startsWith(dist) || !existsSync(f)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
test.afterAll(() => server?.close());

/** share of bright (lit) pixels in each visual row of the line */
async function litPerRow(page: Page, pos: number): Promise<number[]> {
  await page.evaluate((p) => ((window as unknown as { __pos: number }).__pos = p), pos);
  await page.waitForTimeout(400);
  const rows = await page.evaluate(() => {
    const el = document.querySelector('.lyric-karaoke-base')!;
    const r = document.createRange();
    r.selectNodeContents(el);
    const out: { y0: number; y1: number }[] = [];
    for (const q of Array.from(r.getClientRects())) {
      if (!out.some((o) => Math.abs(o.y0 - q.top) < 4)) out.push({ y0: q.top, y1: q.bottom });
    }
    const box = el.getBoundingClientRect();
    return { rows: out, x0: box.left, x1: box.right };
  });
  const png = await page.screenshot();
  return page.evaluate(
    async ({ b64, rows }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return rows.rows.map((row) => {
        const y0 = Math.round(row.y0 + 4);
        const h = Math.max(1, Math.round(row.y1 - row.y0 - 8));
        const d = g.getImageData(Math.round(rows.x0), y0, Math.round(rows.x1 - rows.x0), h).data;
        let lit = 0;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) {
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          if (v > 40) ink++;
          if (v > 200) lit++;
        }
        return ink ? lit / ink : 0;
      });
    },
    { b64: png.toString('base64'), rows }
  );
}

for (const engine of ['columns', 'transform'] as const) {
  test(`wrapped line fills row by row (${engine})`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 420, height: 260 },
      userAgent:
        engine === 'columns'
          ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130',
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/karaoke.html`);
    await page.waitForSelector('.lyric-karaoke');
    const full = await litPerRow(page, 11);
    expect(full.length).toBe(2);
    const early = await litPerRow(page, 0.35 + 2.5);
    const late = await litPerRow(page, 0.35 + 7.8);
    const rel = (v: number[]) => v.map((x, i) => x / (full[i] || 1));
    const e = rel(early);
    const l = rel(late);
    console.log(engine, { full, early: e, late: l });
    // a quarter in: the first row is partly lit, the second still dim
    expect(e[0]).toBeGreaterThan(0.15);
    expect(e[1]).toBeLessThan(0.05);
    // near the end: the first row is fully lit, the second partly
    expect(l[0]).toBeGreaterThan(0.95);
    expect(l[1]).toBeGreaterThan(0.15);
    expect(l[1]).toBeLessThan(0.98);
    await ctx.close();
  });
}

// the wipe polls the audio clock every 50ms; a hidden / minimized window must not
test('karaoke stops polling while the window is hidden', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 260 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __hidden: boolean; __reads: number; __p: number };
    w.__hidden = false;
    w.__reads = 0;
    w.__p = 0;
    Object.defineProperty(document, 'hidden', { get: () => w.__hidden });
    Object.defineProperty(window, '__pos', {
      get: () => {
        w.__reads++;
        return w.__p;
      },
      set: (v) => (w.__p = v),
    });
  });
  await page.goto(`${base}/karaoke.html`);
  await page.waitForSelector('.lyric-karaoke');
  const reads = async (hidden: boolean) => {
    await page.evaluate((h) => {
      const w = window as unknown as { __hidden: boolean; __reads: number };
      w.__hidden = h;
      document.dispatchEvent(new Event('visibilitychange'));
      w.__reads = 0;
    }, hidden);
    await page.waitForTimeout(2000);
    return page.evaluate(() => (window as unknown as { __reads: number }).__reads);
  };
  const visible = await reads(false);
  const hidden = await reads(true);
  console.log('karaoke clock reads per 2s', { visible, hidden });
  expect(visible).toBeGreaterThan(20);
  expect(hidden).toBeLessThanOrEqual(1);
  await ctx.close();
});
