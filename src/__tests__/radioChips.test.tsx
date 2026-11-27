import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import songRadio from './fixtures/ytm/next_song_radio.json';
import tunedRadio from './fixtures/ytm/next_radio_tuned.json';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

const { getRadioChips, getRadioTracks, parseRadioChips } = await import('../api/youtube');
const { RadioChips } = await import('../components/queue/RadioChips');
const { QueueDrawer } = await import('../components/queue/QueueDrawer');
const { replaceUpcoming } = await import('../utils/playback');

const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const sentBody = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string);

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => fetchMock.mockReset());

describe('radio chips from the next endpoint', () => {
  it('reads labels, the selected chip and each tuned endpoint', () => {
    const chips = parseRadioChips(songRadio);
    expect(chips.map((c) => c.label).slice(0, 4)).toEqual([
      'All',
      'Popular',
      'Discover',
      'Deep cuts',
    ]);
    expect(chips.filter((c) => c.selected).map((c) => c.label)).toEqual(['All']);
    expect(chips[0].playlistId).toBe('RDAMVM5NV6Rdv1a3I');
    expect(chips[1].playlistId).toBe('RDATpYv5NV6Rdv1a3I');
    expect(chips.every((c) => c.params.length > 0)).toBe(true);
  });

  it('has no chips for a tuned queue, an album or garbage', () => {
    expect(parseRadioChips(tunedRadio)).toEqual([]);
    expect(parseRadioChips({ contents: {} })).toEqual([]);
    expect(parseRadioChips(null)).toEqual([]);
  });

  it('asks for the radio with the queue playlist and reads its chips', async () => {
    fetchMock.mockResolvedValueOnce(json(songRadio));
    const chips = await getRadioChips('5NV6Rdv1a3I', 'RDEMni3jl65KF37F9JYsJM8DGg', 'pl');
    expect(chips).toHaveLength(13);
    const body = sentBody(0);
    expect(body.playlistId).toBe('RDEMni3jl65KF37F9JYsJM8DGg');
    expect(body.videoId).toBe('5NV6Rdv1a3I');
    expect(body.context.client.hl).toBe('pl');
  });

  it('tunes from the playing song with the chip endpoint and drops that song', async () => {
    const popular = parseRadioChips(songRadio)[1];
    fetchMock.mockResolvedValueOnce(json(tunedRadio));
    const tracks = await getRadioTracks('5NV6Rdv1a3I', 'en', false, popular);
    const body = sentBody(0);
    expect(body.playlistId).toBe(popular.playlistId);
    expect(body.params).toBe(popular.params);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.some((t) => t.id === '5NV6Rdv1a3I')).toBe(false);
  });

  it('keeps the plain song radio without a tune', async () => {
    fetchMock.mockResolvedValueOnce(json(songRadio));
    await getRadioTracks('5NV6Rdv1a3I', 'en');
    expect(sentBody(0)).toMatchObject({ playlistId: 'RDAMVM5NV6Rdv1a3I', params: 'wAEB' });
  });
});

describe('radio chip row', () => {
  const chips = parseRadioChips(songRadio);
  const render = (el: React.ReactElement) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, unmount: () => act(() => root.unmount()) };
  };

  it('marks the selected chip, shows loading and reports the pick', () => {
    const onTune = vi.fn();
    const radio = { chips, active: 1, busy: 2, tuned: true };
    const { host, unmount } = render(<RadioChips radio={radio} label="Tune" onTune={onTune} />);
    const group = host.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-busy')).toBe('true');
    const pressed = host.querySelectorAll('[aria-pressed="true"]');
    expect(Array.from(pressed).map((b) => b.textContent)).toEqual(['Popular']);
    expect(host.querySelectorAll('button')[2].querySelector('.spin-icon')).not.toBeNull();
    act(() =>
      host.querySelectorAll('button')[3].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(onTune).toHaveBeenCalledWith(3);
    unmount();
  });

  it('is hidden in the queue drawer when the queue is not a radio', () => {
    const base = {
      open: true,
      queue: [],
      queueIndex: 0,
      t: { radioTune: 'Tune' },
      onClose: () => {},
      onSelectTrack: () => {},
      onTuneRadio: () => {},
    };
    const plain = render(<QueueDrawer {...base} radio={null} />);
    expect(plain.host.querySelector('.radio-chips')).toBeNull();
    plain.unmount();
    const radio = { chips, active: 0, busy: null, tuned: false };
    const tuned = render(<QueueDrawer {...base} radio={radio} />);
    expect(tuned.host.querySelectorAll('.radio-chips .mood-chip')).toHaveLength(chips.length);
    tuned.unmount();
  });
});

describe('tuned radio replaces only what is still to come', () => {
  const tr = (id: string) => ({ id });
  it('keeps played tracks and the current one, drops repeats of them', () => {
    const q = ['a', 'b', 'c', 'd', 'e'].map(tr);
    const next = replaceUpcoming(q, 2, ['c', 'x', 'a', 'y'].map(tr));
    expect(next.map((t) => t.id)).toEqual(['a', 'b', 'c', 'x', 'y']);
  });
});
