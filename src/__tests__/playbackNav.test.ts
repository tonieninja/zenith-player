import { describe, expect, it } from 'vitest';
import {
  PREV_RESTART_SECS,
  decidePrevious,
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
