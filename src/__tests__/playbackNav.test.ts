import { describe, expect, it } from 'vitest';
import {
  PREV_RESTART_SECS,
  decidePrevious,
  pickPrevPosition,
  popPlayHistory,
  pushPlayHistory,
} from '../utils/playbackNav';

describe('decidePrevious', () => {
  it('restarts when past the threshold', () => {
    expect(
      decidePrevious({
        positionSec: PREV_RESTART_SECS + 0.1,
        queueIndex: 2,
        queueLength: 5,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'restart' });
  });

  it('goes to the prior index when near the start', () => {
    expect(
      decidePrevious({
        positionSec: 1,
        queueIndex: 2,
        queueLength: 5,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'goto', index: 1 });
  });

  it('goes to the previous track at 2 seconds instead of restarting', () => {
    expect(
      decidePrevious({
        positionSec: 2,
        queueIndex: 2,
        queueLength: 5,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'goto', index: 1 });
  });

  it('goes to the previous track just under the 3 second mark', () => {
    expect(
      decidePrevious({
        positionSec: 2.9,
        queueIndex: 2,
        queueLength: 5,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'goto', index: 1 });
  });

  it('restarts at exactly 3 seconds', () => {
    expect(
      decidePrevious({
        positionSec: PREV_RESTART_SECS,
        queueIndex: 2,
        queueLength: 5,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'restart' });
  });

  it('uses history even when shuffle is off', () => {
    expect(
      decidePrevious({
        positionSec: 1,
        queueIndex: 3,
        queueLength: 4,
        loopMode: 'off',
        shuffleOn: false,
        historyIds: ['a', 'b'],
        queueIds: ['x', 'b', 'y', 'z'],
      })
    ).toEqual({ kind: 'goto', index: 1 });
  });

  it('wraps on loop-all from the first track', () => {
    expect(
      decidePrevious({
        positionSec: 0,
        queueIndex: 0,
        queueLength: 4,
        loopMode: 'all',
      })
    ).toEqual({ kind: 'goto', index: 3 });
  });

  it('uses shuffle history when available', () => {
    expect(
      decidePrevious({
        positionSec: 0.5,
        queueIndex: 3,
        queueLength: 4,
        loopMode: 'off',
        shuffleOn: true,
        historyIds: ['a', 'b'],
        queueIds: ['x', 'b', 'y', 'z'],
      })
    ).toEqual({ kind: 'goto', index: 1 });
  });

  it('noops at the start without loop', () => {
    expect(
      decidePrevious({
        positionSec: 0,
        queueIndex: 0,
        queueLength: 3,
        loopMode: 'off',
      })
    ).toEqual({ kind: 'noop' });
  });
});

describe('pickPrevPosition', () => {
  it('prefers the painted time when the audio element is still on the old track', () => {
    expect(pickPrevPosition(2, 90)).toBe(2);
    expect(pickPrevPosition(2.1, 2.1)).toBe(2.1);
    expect(pickPrevPosition(Number.NaN, 4)).toBe(4);
    expect(pickPrevPosition(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe('play history stack', () => {
  it('pushes and pops without duplicating the tail', () => {
    let h = pushPlayHistory([], 'a');
    h = pushPlayHistory(h, 'a');
    expect(h).toEqual(['a']);
    h = pushPlayHistory(h, 'b');
    expect(h).toEqual(['a', 'b']);
    const popped = popPlayHistory(h, 'c');
    expect(popped.previousId).toBe('b');
    expect(popped.history).toEqual(['a']);
  });
});
