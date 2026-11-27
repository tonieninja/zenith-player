import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { discordPresencePlugin, getDiscordClientId, DEFAULT_CLIENT_ID } =
  await import('../plugins/discordPresence');
const { discordStatusText } = await import('../components/plugins/DiscordStatus');

const info = {
  id: 'StZcUAPRRac',
  title: 'Sonne',
  artist: 'Rammstein',
  duration: 272,
  position: 10,
  isPlaying: true,
};
const updates = () => invoke.mock.calls.filter((c) => c[0] === 'discord_update_presence');

describe('discord presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });
  afterEach(() => {
    discordPresencePlugin.onDisable?.();
    vi.useRealTimers();
    localStorage.removeItem('zenith_discord_client_id');
  });

  it('retries once after a failed send with the position moved on', async () => {
    invoke.mockRejectedValueOnce('no discord').mockResolvedValue(undefined);
    discordPresencePlugin.onNowPlaying?.(info);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updates()).toHaveLength(2);
    const pos = updates()[1][1].payload.position;
    expect(pos).toBeGreaterThan(24);
    expect(pos).toBeLessThan(26);
  });

  it('resends an update that met the previous one still in flight within a second', async () => {
    invoke.mockRejectedValueOnce('busy').mockResolvedValue(undefined);
    discordPresencePlugin.onNowPlaying?.({ ...info, isPlaying: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates()).toHaveLength(2);
    expect(updates()[1][1].payload.isPlaying).toBe(false);
  });

  it('keeps retrying until Discord is started and then stops', async () => {
    invoke.mockRejectedValue('no discord');
    discordPresencePlugin.onNowPlaying?.({ ...info, isPlaying: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates()).toHaveLength(5);
    invoke.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates()).toHaveLength(6);
    expect(updates()[5][1].payload).toMatchObject({ isPlaying: false, position: 10 });
  });

  it('does not retry after the plugin is turned off', async () => {
    invoke.mockRejectedValueOnce('no discord').mockResolvedValue(undefined);
    discordPresencePlugin.onNowPlaying?.(info);
    await vi.advanceTimersByTimeAsync(1);
    discordPresencePlugin.onDisable?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updates()).toHaveLength(1);
  });

  it('ignores a half-typed or junk app ID', () => {
    localStorage.setItem('zenith_discord_client_id', '15143');
    expect(getDiscordClientId()).toBe(DEFAULT_CLIENT_ID);
    localStorage.setItem('zenith_discord_client_id', ' 123456789012345678 ');
    expect(getDiscordClientId()).toBe('123456789012345678');
  });

  it('turns backend status codes into readable lines', () => {
    const t = {
      connected: 'as {name}',
      waiting: 'wait',
      noDiscord: 'none',
      badId: 'bad',
      rejected: 'rej',
    };
    expect(discordStatusText('connected:Ola', t)).toEqual({ text: 'as Ola', ok: true });
    expect(discordStatusText('invalid-app-id', t).text).toBe('bad');
    expect(discordStatusText('rejected:Invalid payload', t).text).toBe('rej (Invalid payload)');
    expect(discordStatusText('', t).text).toBe('wait');
  });
});
