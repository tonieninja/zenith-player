import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { findLikeStatus, likeEndpointFor, nextLikeStatus } from '../api/youtube';

describe('YouTube Music like / dislike', () => {
  it('uses like, dislike and removelike endpoints', () => {
    expect(likeEndpointFor('LIKE')).toBe('like/like');
    expect(likeEndpointFor('DISLIKE')).toBe('like/dislike');
    expect(likeEndpointFor('INDIFFERENT')).toBe('like/removelike');
  });

  it('toggles a thumb off when it is clicked again', () => {
    expect(nextLikeStatus('INDIFFERENT', 'like')).toBe('LIKE');
    expect(nextLikeStatus('LIKE', 'like')).toBe('INDIFFERENT');
    expect(nextLikeStatus('LIKE', 'dislike')).toBe('DISLIKE');
    expect(nextLikeStatus('DISLIKE', 'dislike')).toBe('INDIFFERENT');
    expect(nextLikeStatus('DISLIKE', 'like')).toBe('LIKE');
  });
});

describe('like state from the player data', () => {
  it('reads the thumb of the playing track out of playerOverlays', () => {
    const overlays = {
      playerOverlayRenderer: {
        actions: [{ likeButtonRenderer: { likeStatus: 'LIKE', likesAllowed: true } }],
      },
    };
    expect(findLikeStatus(overlays)).toBe('LIKE');
    expect(findLikeStatus({ actions: [{ likeButtonRenderer: { likeStatus: 'DISLIKE' } }] })).toBe(
      'DISLIKE'
    );
  });

  it('gives null when the answer has no like button', () => {
    expect(findLikeStatus(undefined)).toBeNull();
    expect(findLikeStatus({ playerOverlayRenderer: {} })).toBeNull();
  });
});
