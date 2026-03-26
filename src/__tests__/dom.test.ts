import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKeyboardHandler, setupKeyboardShortcuts } from '../plugins/keyboardShortcuts';
import { isInsideDialog, isTypingEvent, applyWheelVolume, wheelVolumeDelta } from '../utils/dom';

const key = (code: string, k = code) =>
  new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keyboard shortcuts stay out of typing', () => {
  it('treats a key as typing when the focused field is an input, wherever the event lands', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const e = key('KeyN', 'n');
    document.body.dispatchEvent(e);
    expect(isTypingEvent(e)).toBe(true);
  });

  it('does not count checkboxes and buttons as typing', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.appendChild(box);
    box.focus();
    const e = key('Space', ' ');
    box.dispatchEvent(e);
    expect(isTypingEvent(e)).toBe(false);
  });

  it('counts IME composition as typing', () => {
    const e = new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, isComposing: true });
    expect(isTypingEvent(e)).toBe(true);
  });

  it('keeps N / Space / arrows away from the player while typing or inside a dialog', () => {
    const handler = vi.fn();
    registerKeyboardHandler(handler);
    const stop = setupKeyboardShortcuts(true);
    try {
      const overlay = document.createElement('div');
      overlay.className = 'global-modal-overlay';
      const input = document.createElement('input');
      const toggle = document.createElement('button');
      overlay.append(input, toggle);
      document.body.appendChild(overlay);

      input.focus();
      const typed = key('KeyN', 'n');
      document.body.dispatchEvent(typed);
      expect(typed.defaultPrevented).toBe(false);

      toggle.focus();
      const space = key('Space', ' ');
      toggle.dispatchEvent(space);
      expect(isInsideDialog(space)).toBe(true);
      expect(space.defaultPrevented).toBe(false);
      expect(handler).not.toHaveBeenCalled();

      toggle.blur();
      overlay.remove();
      window.dispatchEvent(key('KeyN', 'n'));
      expect(handler).toHaveBeenCalledWith('next');
    } finally {
      stop();
    }
  });
});

describe('wheel volume', () => {
  it('one mouse notch up is +2%, down is -2%', () => {
    expect(applyWheelVolume(0.5, { deltaY: -100, deltaMode: 0 })).toBe(0.52);
    expect(applyWheelVolume(0.5, { deltaY: 100, deltaMode: 0 })).toBe(0.48);
    expect(applyWheelVolume(0.5, { deltaY: -3, deltaMode: 1 })).toBe(0.52);
    expect(applyWheelVolume(0.5, { deltaY: -53, deltaMode: 0 })).toBe(0.52);
  });
  it('Shift makes it 1%, also when the engine reports a horizontal delta', () => {
    expect(applyWheelVolume(0.5, { deltaY: -100, shiftKey: true })).toBe(0.51);
    expect(applyWheelVolume(0.5, { deltaY: 0, deltaX: -100, shiftKey: true })).toBe(0.51);
  });
  it('trackpad deltas move a little, and limits hold', () => {
    const d = wheelVolumeDelta({ deltaY: -4, deltaMode: 0 });
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.002);
    expect(applyWheelVolume(0.99, { deltaY: -300 })).toBe(1);
    expect(applyWheelVolume(0.01, { deltaY: 300 })).toBe(0);
    expect(wheelVolumeDelta({ deltaY: 0 })).toBe(0);
  });
});
