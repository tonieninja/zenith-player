import { beforeEach, describe, expect, it } from 'vitest';
import { playOnStart, setQueueStart } from '../plugins/queuePersist';
import {
  saveRememberedVolume,
  setFixedVolume,
  setFixedVolumeOn,
  startupVolume,
} from '../plugins/rememberVolume';

beforeEach(() => localStorage.clear());

describe('startupVolume', () => {
  it('uses the last level until a fixed one is switched on', () => {
    expect(startupVolume()).toBeNull();
    saveRememberedVolume(0.37);
    expect(startupVolume()).toBe(0.37);
    setFixedVolume(0.2);
    expect(startupVolume()).toBe(0.37);
    setFixedVolumeOn(true);
    expect(startupVolume()).toBe(0.2);
    setFixedVolumeOn(false);
    expect(startupVolume()).toBe(0.37);
  });

  it('starts at half volume when the fixed level was never set', () => {
    setFixedVolumeOn(true);
    expect(startupVolume()).toBe(0.5);
  });
});

describe('playOnStart', () => {
  it('follows the state at close by default and the choice once made', () => {
    expect(playOnStart(true)).toBe(true);
    expect(playOnStart(false)).toBe(false);
    setQueueStart('play');
    expect(playOnStart(false)).toBe(true);
    setQueueStart('pause');
    expect(playOnStart(true)).toBe(false);
  });
});
