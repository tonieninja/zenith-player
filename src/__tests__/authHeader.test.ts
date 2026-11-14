import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => '' }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { sapisidAuthorization } from '../api/youtube';

const TS = 1_700_000_000;

describe('sapisid authorization', () => {
  it('sends the 1p and 3p hashes chrome sends', async () => {
    const auth = await sapisidAuthorization(
      'SAPISID=secret; __Secure-1PAPISID=one; __Secure-3PAPISID=three',
      TS
    );
    expect(auth).toBe(
      'SAPISIDHASH 1700000000_d2a0deeb95ea263a68778d9e9ac8840dce59d800 SAPISID1PHASH 1700000000_da24a2c934790185633fc7b6b66bd84107f1999e SAPISID3PHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca'
    );
  });

  it('falls back to the 3p secret when SAPISID is missing', async () => {
    const auth = await sapisidAuthorization('__Secure-3PAPISID=three', TS);
    expect(auth.startsWith('SAPISIDHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca')).toBe(
      true
    );
    expect(auth).toContain('SAPISID3PHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca');
  });
});
