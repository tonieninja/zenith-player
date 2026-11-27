import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { rescanLocalFolders } from '../components/LocalFilesSetting';

describe('local folder scan', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem('zenith_local_folders');
  });

  it('retries with the current folder list once the running scan ends', async () => {
    vi.useFakeTimers();
    localStorage.setItem('zenith_local_folders', JSON.stringify(['C:/Music']));
    invokeMock.mockReset();
    invokeMock
      .mockRejectedValueOnce('scan already running')
      .mockRejectedValueOnce('scan already running')
      .mockResolvedValue(undefined);
    rescanLocalFolders();
    await vi.advanceTimersByTimeAsync(0);
    localStorage.setItem('zenith_local_folders', JSON.stringify(['C:/Music', 'D:/Flac']));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith('local_scan', { folders: ['C:/Music', 'D:/Flac'] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
});
