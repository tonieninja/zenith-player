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

  it('is a labelled dialog that takes focus, keeps Tab inside and gives focus back', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ModalOverlay testId="dlg">
          <h2>Settings</h2>
          <button type="button">first</button>
          <button type="button">last</button>
        </ModalOverlay>
      );
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const overlay = document.querySelector('[data-testid="dlg"]') as HTMLElement;
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(overlay.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Settings');
    const [first, last] = Array.from(overlay.querySelectorAll('button'));
    expect(document.activeElement).toBe(first);

    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    host.remove();
    opener.remove();
  });
});
