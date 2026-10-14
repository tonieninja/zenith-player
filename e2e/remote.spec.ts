import { test, expect, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG = resolve('src-tauri', process.env.ZENITH_REMOTE_E2E_LOG || 'target-e2e-cmds.log');
const cmds = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function unlock(page: Page) {
  await page.goto('/');
  await expect(page.locator('#pin')).toHaveClass(/show/);
  await page.fill('#pinin', '4321');
  await page.click('#pinok');
  await expect(page.locator('#title')).toHaveText('E2E Song');
}

test('manifest and icons for the home-screen app', async ({ request }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m.display).toBe('standalone');
  expect((await request.get('/icon-512.png')).headers()['content-type']).toContain('image/png');
});

test('PIN gate, state and controls', async ({ page }) => {
  await unlock(page);
  await expect(page.locator('#artist')).toHaveText('Test Artist');
  const before = cmds().length;
  await page.click('#toggle');
  await page.locator('#next').dispatchEvent('pointerdown');
  await page.locator('#next').dispatchEvent('pointerup');
  await expect
    .poll(() =>
      cmds()
        .slice(before)
        .map((c) => c.cmd)
    )
    .toEqual(expect.arrayContaining(['toggle', 'next']));
});

test('hold next to scrub forward', async ({ page }) => {
  await unlock(page);
  const before = cmds().length;
  await page.locator('#next').dispatchEvent('pointerdown');
  await page.waitForTimeout(1200);
  await page.locator('#next').dispatchEvent('pointerup');
  const seeks = cmds()
    .slice(before)
    .filter((c) => c.cmd === 'seek');
  expect(seeks.length).toBeGreaterThanOrEqual(2);
  expect(
    cmds()
      .slice(before)
      .some((c) => c.cmd === 'next')
  ).toBe(false);
});

test('sleep timer sheet sends minutes', async ({ page }) => {
  await unlock(page);
  const before = cmds().length;
  await page.click('#sleepbtn');
  await page.locator('#sheet [data-m="30"]').click();
  await expect
    .poll(
      () =>
        cmds()
          .slice(before)
          .find((c) => c.cmd === 'sleep')?.minutes
    )
    .toBe(30);
});

test('synced lyrics highlight the current line', async ({ page }) => {
  await unlock(page);
  await page.click('button[data-tab="lyrics"]');
  await expect(page.locator('#lyr .on')).toHaveText('current line');
});

test('previous, shuffle, like, mute and volume send commands', async ({ page }) => {
  await unlock(page);
  const before = cmds().length;
  await page.click('#prev');
  await page.click('#shuffle');
  await page.click('#like');
  await page.click('#mute');
  await page.locator('#vol').evaluate((el: HTMLInputElement) => {
    el.value = '20';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect
    .poll(() =>
      cmds()
        .slice(before)
        .map((c) => c.cmd)
    )
    .toEqual(expect.arrayContaining(['prev', 'shuffle', 'like', 'mute']));
});

test('queue and search tabs are reachable', async ({ page }) => {
  await unlock(page);
  await page.click('button[data-tab="queue"]');
  await expect(page.locator('#tab-queue')).toBeVisible();
  await page.click('button[data-tab="search"]');
  await expect(page.locator('#q')).toBeVisible();
  await page.fill('#q', 'test');
});
