import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useScrubBar } from '../hooks/useScrubBar';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function Bar(props: {
  onSeek: (t: number) => void;
  onScrub: (t: number) => void;
  renders: () => void;
}) {
  props.renders();
  const s = useScrubBar(100, props.onSeek, props.onScrub);
  return (
    <div
      data-testid="bar"
      ref={s.trackRef}
      onPointerDown={s.onPointerDown}
      onPointerMove={s.onPointerMove}
      onPointerUp={s.onPointerUp}
      onPointerCancel={s.onPointerCancel}
    />
  );
}

function setup() {
  const onSeek = vi.fn();
  const onScrub = vi.fn();
  const renders = vi.fn();
  const el = document.createElement('div');
  document.body.appendChild(el);
  act(() => createRoot(el).render(<Bar onSeek={onSeek} onScrub={onScrub} renders={renders} />));
  const bar = el.querySelector<HTMLDivElement>('[data-testid="bar"]')!;
  bar.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
  bar.setPointerCapture = () => {};
  bar.hasPointerCapture = () => false;
  const fire = (type: string, x: number) =>
    act(() => {
      bar.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x }));
    });
  return { onSeek, onScrub, renders, fire };
}

describe('scrub bar', () => {
  it('previews while dragging and seeks once on release', () => {
    const { onSeek, onScrub, renders, fire } = setup();
    renders.mockClear();
    fire('pointerdown', 20);
    for (let x = 30; x <= 120; x += 10) fire('pointermove', x);
    fire('pointerup', 120);
    expect(onScrub).toHaveBeenCalledTimes(11);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(60);
    // dwa rendery na całe ciągnięcie (start i koniec), nie jeden na każdy ruch
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it('does not seek when the drag is cancelled', () => {
    const { onSeek, fire } = setup();
    fire('pointerdown', 20);
    fire('pointermove', 80);
    fire('pointercancel', 80);
    expect(onSeek).not.toHaveBeenCalled();
  });
});
