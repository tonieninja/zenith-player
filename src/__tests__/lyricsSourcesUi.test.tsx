import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LyricsSourceBar } from '../components/LyricsSourceBar';
import { LyricsSourcesSettings } from '../components/LyricsSourcesSettings';
import { getLyricsPrefs, setLyricsPrefs } from '../lyrics/prefs';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  setLyricsPrefs(null);
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  return el;
}

const names = (el: HTMLElement) =>
  [...el.querySelectorAll('.lyrics-source-name')].map((n) => n.textContent);

describe('lyrics sources settings', () => {
  it('stars, moves and switches off sources and saves each change', () => {
    const el = mount(<LyricsSourcesSettings lang="en" />);
    const row = (id: string) =>
      [...el.querySelectorAll('.lyrics-source-row')].find((r) => r.textContent?.includes(id))!;
    act(() => row('Kugou').querySelector<HTMLElement>('.lyrics-source-star')!.click());
    expect(names(el)[0]).toBe('Kugou');
    expect(getLyricsPrefs().order[0]).toBe('Kugou');
    const moves = row('Kugou').querySelectorAll<HTMLButtonElement>('.lyrics-source-move');
    expect(moves[0].disabled).toBe(true);
    act(() => moves[1].click());
    expect(names(el)[1]).toBe('Kugou');
    act(() => row('Boidu').querySelector<HTMLElement>('[role="switch"]')!.click());
    expect(getLyricsPrefs().off).toEqual(['Boidu']);
    expect(row('Boidu').className).toContain('off');
  });
});

describe('lyrics source bar', () => {
  it('marks the source in use, dims misses and says what it switched from', () => {
    const el = mount(
      <LyricsSourceBar
        providers={['Auto', 'Musixmatch', 'LRCLib', 'Boidu']}
        selected="Auto"
        loading={false}
        top="Musixmatch"
        lang="en"
        lyrics={{
          provider: 'Musixmatch',
          text: null,
          synced: [{ time: 1, text: 'a' }],
          upgradedFrom: 'LRCLib',
          failures: [{ provider: 'Boidu', reason: 'No lyrics found for this track' }],
        }}
        onSelect={() => {}}
        onManage={() => {}}
      />
    );
    const chip = (id: string) =>
      [...el.querySelectorAll<HTMLElement>('.lyrics-provider-pill')].find(
        (c) => c.textContent === id
      )!;
    expect(chip('Musixmatch').className).toContain('in-use');
    expect(chip('Boidu').className).toContain('no-result');
    expect(chip('LRCLib').className).not.toContain('in-use');
    expect(el.querySelector('.lyrics-provider-caption')?.textContent).toBe('Switched from LRCLib');
    expect(el.querySelector('.lyrics-provider-title .lyrics-provider-star')).not.toBeNull();
  });
});
