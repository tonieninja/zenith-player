import { ZenithPlugin } from './types';

export interface AbLoopState {
  a: number | null;
  b: number | null;
  active: boolean;
}

export type AbLoopPhase = 'off' | 'a' | 'ab';

export const AB_LOOP_EARLY_S = 0.03;

export function abLoopSeekTarget(
  currentTime: number,
  a: number,
  b: number,
  earlySec = AB_LOOP_EARLY_S
): number | null {
  if (!Number.isFinite(currentTime) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!(b > a + 0.2)) return null;
  if (currentTime >= b - earlySec) return a;
  return null;
}

let state: AbLoopState = { a: null, b: null, active: false };
let sink: ((a: number | null, b: number | null) => void) | null = null;
const listeners = new Set<(s: AbLoopState) => void>();

function changed() {
  const s = getAbLoop();
  sink?.(s.active ? s.a : null, s.active ? s.b : null);
  for (const fn of listeners) fn(s);
}

export function getAbLoop(): AbLoopState {
  return { ...state };
}

export function abLoopPhase(s: AbLoopState = state): AbLoopPhase {
  if (s.active) return 'ab';
  return s.a !== null ? 'a' : 'off';
}

export function setAbPoint(which: 'a' | 'b', time: number) {
  if (which === 'a') state.a = time;
  else state.b = time;
  state.active = state.a !== null && state.b !== null && state.b > state.a + 0.2;
  changed();
}

export function clearAbLoop() {
  const had = state.a !== null || state.b !== null;
  state = { a: null, b: null, active: false };
  if (had) changed();
}

export function cycleAbLoop(time: number): AbLoopState {
  if (state.a === null) setAbPoint('a', time);
  else if (state.b === null) setAbPoint('b', time);
  else clearAbLoop();
  return getAbLoop();
}

export function registerAbLoopSink(fn: (a: number | null, b: number | null) => void) {
  sink = fn;
  fn(state.active ? state.a : null, state.active ? state.b : null);
}

export function subscribeAbLoop(fn: (s: AbLoopState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const abLoopPlugin: ZenithPlugin = {
  id: 'ab-loop',
  name: 'A-B Loop',
  category: 'playback',
  description: 'Mark two points in a track and loop between them.',
  defaultEnabled: false,
  onTrackChange() {
    clearAbLoop();
  },
  onDisable() {
    clearAbLoop();
  },
};
