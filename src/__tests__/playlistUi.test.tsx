import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  contextMenuCoords,
  menuKeyIndex,
  PopoverMenu,
  popoverMenuCoords,
} from '../components/ui/PopoverMenu';
import { ctxTrackAttr, isVideoTrackId, parseCtxTrackAttr, isPrimaryButton } from '../utils/tracks';
import appCss from '../App.css?raw';

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

  it('parses the payload even when a bare video id was stored', () => {
    const raw = ctxTrackAttr({
      id: 'dQw4w9WgXcQ',
      type: 'track',
      title: 'Szampan',
      artist: 'Sanah',
      cover: '',
    });
    expect(parseCtxTrackAttr(raw)?.id).toBe('dQw4w9WgXcQ');
    expect(parseCtxTrackAttr('dQw4w9WgXcQ')?.id).toBe('dQw4w9WgXcQ');
    expect(parseCtxTrackAttr('not-json-and-not-an-id')).toBeNull();
  });

  it('keeps artist and album refs so the menu can go to them', () => {
    const raw = ctxTrackAttr({
      id: 'dQw4w9WgXcQ',
      type: 'track',
      title: 'Song',
      artist: 'A',
      cover: '',
      artistId: 'UCabc',
      albumId: 'MPREb_x',
      album: 'Album',
      durationSec: 213,
    });
    expect(parseCtxTrackAttr(raw)).toMatchObject({
      artistId: 'UCabc',
      albumId: 'MPREb_x',
      album: 'Album',
      durationSec: 213,
    });
    const bad = JSON.stringify({ id: 'dQw4w9WgXcQ', artistId: 5, albumId: '', durationSec: 'x' });
    const parsed = parseCtxTrackAttr(bad);
    expect(parsed?.artistId).toBeUndefined();
    expect(parsed?.albumId).toBeUndefined();
    expect(parsed?.durationSec).toBeUndefined();
  });

  it('does not treat a right click as activating the card', () => {
    expect(isPrimaryButton(0)).toBe(true);
    expect(isPrimaryButton(2)).toBe(false);
  });
});

describe('song context menu placement and keys', () => {
  const area = { width: 1280, bottom: 700 };
  const size = { width: 220, height: 260 };

  it('opens at the cursor when it fits above the player bar', () => {
    expect(contextMenuCoords(300, 200, size, area)).toEqual({ left: 300, top: 200 });
  });

  it('opens upward near the player bar and stays inside the window', () => {
    expect(contextMenuCoords(300, 690, size, area)).toEqual({ left: 300, top: 430 });
    expect(contextMenuCoords(1270, 200, size, area).left).toBe(1280 - 220 - 8);
    // klik na samym pasku odtwarzacza: menu i tak kończy się nad nim
    expect(contextMenuCoords(300, 760, size, area).top).toBe(700 - 260 - 8);
    expect(contextMenuCoords(300, 100, { width: 220, height: 900 }, area).top).toBe(8);
  });

  it('moves focus with arrows, Home and End, wrapping at the ends', () => {
    expect(menuKeyIndex('ArrowDown', -1, 4)).toBe(0);
    expect(menuKeyIndex('ArrowUp', -1, 4)).toBe(3);
    expect(menuKeyIndex('ArrowDown', 3, 4)).toBe(0);
    expect(menuKeyIndex('ArrowUp', 0, 4)).toBe(3);
    expect(menuKeyIndex('Home', 2, 4)).toBe(0);
    expect(menuKeyIndex('End', 0, 4)).toBe(3);
    expect(menuKeyIndex('Enter', 0, 4)).toBeNull();
    expect(menuKeyIndex('ArrowDown', -1, 0)).toBe(0);
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

describe('popover menu stacking', () => {
  const z = (sel: string) => {
    const block = appCss.slice(appCss.indexOf(`${sel} {`));
    return Number(/z-index:\s*(\d+)/.exec(block.slice(0, block.indexOf('}')))?.[1]);
  };

  it('draws above modal overlays so menus inside the playlist manager can be clicked', () => {
    expect(z('.zen-popover-menu-list')).toBeGreaterThan(z('.global-modal-overlay'));
    expect(z('.zen-popover-menu-list')).toBeLessThan(20000);
  });
});
