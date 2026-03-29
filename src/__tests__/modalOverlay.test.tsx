import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ModalOverlay } from '../components/ui/ModalOverlay';

describe('ModalOverlay', () => {
  it('renders on document.body so overflow:clip ancestors cannot hide it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root | null = null;
    act(() => {
      root = createRoot(host);
      root.render(
        <ModalOverlay testId="settings-overlay">
          <div>settings</div>
        </ModalOverlay>
      );
    });
    const overlay = document.querySelector('[data-testid="settings-overlay"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay?.textContent).toContain('settings');
    act(() => root?.unmount());
    host.remove();
  });
});
