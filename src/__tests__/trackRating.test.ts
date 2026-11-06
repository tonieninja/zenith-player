import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { likeEndpointFor, nextLikeStatus } from '../api/youtube';

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
