import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { PopoverMenu, popoverMenuCoords } from '../components/ui/PopoverMenu';
import { ctxTrackAttr, isVideoTrackId } from '../utils/ctxTrack';

describe('song context menu payload', () => {
  it('serializes real songs so Add to playlist can open the picker', () => {
    expect(isVideoTrackId('dQw4w9WgXcQ')).toBe(true);
    const raw = ctxTrackAttr({
      id: 'dQw4w9WgXcQ',
      type: 'track',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      cover: 'https://i.ytimg.com/x.jpg',
    });
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toMatchObject({ id: 'dQw4w9WgXcQ', type: 'track' });
  });

  it('still marks an 11-char song when type was left unset', () => {
    expect(
      ctxTrackAttr({
        id: 'dQw4w9WgXcQ',
        title: 'Song',
        artist: 'A',
        cover: '',
      })
    ).toContain('dQw4w9WgXcQ');
  });

  it('skips playlists, mixes and malformed ids', () => {
    expect(
      ctxTrackAttr({
        id: 'VLPLabc',
        type: 'playlist',
        title: 'Gym',
        artist: 'me',
        cover: '',
      })
    ).toBeUndefined();
    expect(
      ctxTrackAttr({
        id: 'RDTMAK5uy',
        type: 'playlist',
        title: 'Energy Supermix',
        artist: 'YouTube Music',
        cover: '',
      })
    ).toBeUndefined();
    expect(ctxTrackAttr({ id: 'short', type: 'track', title: 'x', artist: 'a', cover: '' })).toBe(
      undefined
    );
  });
});

describe('playlist picker placement', () => {
  it('drops below when there is room, and flips up near the window edge', () => {
    const roomy = popoverMenuCoords(
      { left: 40, right: 180, top: 80, bottom: 120, width: 140 },
      3,
      'left',
      { innerWidth: 1280, innerHeight: 800 }
    );
    expect(roomy.dropUp).toBe(false);
    expect(roomy.top).toBe(126);
    expect(roomy.left).toBe(40);

    const tight = popoverMenuCoords(
      { left: 40, right: 180, top: 720, bottom: 760, width: 140 },
      6,
      'left',
      { innerWidth: 1280, innerHeight: 800 }
    );
    expect(tight.dropUp).toBe(true);
    expect(tight.bottom).toBe(800 - 720 + 6);
  });
});

describe('Add to playlist picker', () => {
  beforeAll(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  it('opens the menu on document.body so overflow:hidden parents cannot clip it', async () => {
    const host = document.createElement('div');
    host.style.overflow = 'hidden';
    host.style.height = '36px';
    document.body.appendChild(host);
    let root: Root | undefined;
    try {
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <PopoverMenu
            ariaLabel="Add to playlist"
            trigger={<span>Add to playlist</span>}
            items={[{ key: 'pl1', label: 'Gym', onSelect: () => {} }]}
          />
        );
      });
      const btn = host.querySelector('button[aria-label="Add to playlist"]') as HTMLButtonElement;
      expect(btn).toBeTruthy();
      await act(async () => {
        btn.click();
      });
      const menu = document.body.querySelector('[data-zen-popover-menu="true"]');
      expect(menu).toBeTruthy();
      expect(menu!.parentElement).toBe(document.body);
      expect(menu!.textContent).toContain('Gym');
      expect(host.contains(menu)).toBe(false);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      host.remove();
    }
  });
});
