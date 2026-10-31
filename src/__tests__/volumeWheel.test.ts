import { describe, expect, it } from 'vitest';
import { applyWheelVolume, wheelVolumeDelta } from '../utils/volumeWheel';

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
