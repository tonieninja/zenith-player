import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ listens: 0, calls: [] as string[] }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => {
    m.listens += 1;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    m.calls.push(cmd);
    if (cmd === 'remote_start') await new Promise((r) => setTimeout(r, 5));
    return { url: '', port: 1 };
  }),
}));

import { startRemote, stopRemote } from '../plugins/remoteControl';

const stops = () => m.calls.filter((c) => c === 'remote_stop').length;

describe('phone remote start and stop', () => {
  beforeEach(async () => {
    await stopRemote();
    m.listens = 0;
    m.calls = [];
  });

  it('listens once when started twice in a row', async () => {
    await Promise.all([startRemote(() => {}), startRemote(() => {})]);
    expect(m.listens).toBe(1);
  });

  it('turns the server back off when stopped while starting', async () => {
    const p = startRemote(() => {});
    await stopRemote();
    await p;
    expect(stops()).toBe(2);
  });

  it('leaves the server to a newer start', async () => {
    const a = startRemote(() => {});
    await stopRemote();
    const b = startRemote(() => {});
    await Promise.all([a, b]);
    expect(stops()).toBe(1);
  });
});
