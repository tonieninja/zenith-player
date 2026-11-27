import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { castPosition, type CastDevice, type CastStatus } from '../hooks/useCast';
import { CastButton } from '../components/player/CastButton';
import { translations } from '../i18n';

const t = translations.en as unknown as Record<string, string>;
const tv: CastDevice = { id: 'a', name: 'Living Room TV', host: '192.168.0.2', port: 8009 };
const box: CastDevice = { id: 'b', name: 'Kitchen speaker', host: '192.168.0.3', port: 8009 };
const status = (over: Partial<CastStatus> = {}): CastStatus => ({
  session: 1,
  conn: 'connected',
  device: tv.name,
  player: 'PLAYING',
  idle: '',
  time: 10,
  duration: 200,
  volume: 0.5,
  muted: false,
  error: '',
  at: 1000,
  ...over,
});

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('cast position', () => {
  it('runs on from the last device report only while playing and stops at the end', () => {
    expect(castPosition(status(), 3500)).toBeCloseTo(12.5);
    expect(castPosition(status({ player: 'PAUSED' }), 3500)).toBe(10);
    expect(castPosition(status({ player: 'BUFFERING' }), 3500)).toBe(10);
    expect(castPosition(status({ time: 199 }), 9000)).toBe(200);
  });
});

async function mount(props: Partial<Parameters<typeof CastButton>[0]>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const all = {
    status: null,
    devices: [],
    scanning: false,
    onScan: vi.fn(),
    onPick: vi.fn(),
    onStop: vi.fn(),
    t,
    ...props,
  };
  await act(async () => createRoot(el).render(<CastButton {...all} />));
  await act(async () => el.querySelector<HTMLElement>('.cast-btn')!.click());
  const menu = () => [...document.querySelectorAll('[role="menu"]')].at(-1)!;
  return { all, el, menu };
}

describe('cast picker', () => {
  it('searches when opened and shows a spinner, then an empty state', async () => {
    const { all, menu } = await mount({ scanning: true });
    expect(all.onScan).toHaveBeenCalledTimes(1);
    expect(menu().querySelector('.spin-icon')).not.toBeNull();
    expect(menu().textContent).toContain(t.castSearching);
    expect(menu().textContent).not.toContain(t.castNoDevices);
    const idle = await mount({ scanning: false });
    expect(idle.menu().textContent).toContain(t.castNoDevices);
  });

  it('casts to a picked device', async () => {
    const { all, menu } = await mount({ devices: [tv, box] });
    const items = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([tv.name, box.name]);
    await act(async () => items[1].click());
    expect(all.onPick).toHaveBeenCalledWith(box);
  });

  it('while casting names the device, lists the others and offers to stop', async () => {
    const { all, el, menu } = await mount({ devices: [tv, box], status: status() });
    const btn = el.querySelector('.cast-btn')!;
    expect(btn.className).toContain('active');
    expect(btn.getAttribute('aria-label')).toBe('Casting to Living Room TV');
    expect(menu().textContent).toContain('Casting to Living Room TV');
    const items = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([box.name, t.castStop]);
    await act(async () => items[1].click());
    expect(all.onStop).toHaveBeenCalled();
  });
});
