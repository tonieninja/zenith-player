import { ZenithPlugin } from './types';

export interface AbLoopState {
  a: number | null;
  b: number | null;
  active: boolean;
}

let state: AbLoopState = { a: null, b: null, active: false };
let onLoop: ((t: number) => void) | null = null;

export function getAbLoop(): AbLoopState {
  return { ...state };
}

export function setAbPoint(which: 'a' | 'b', time: number) {
  if (which === 'a') state.a = time;
  else state.b = time;
  if (state.a !== null && state.b !== null && state.b > state.a) {
    state.active = true;
  }
}

export function clearAbLoop() {
  state = { a: null, b: null, active: false };
}

export function registerAbLoopSeek(fn: (t: number) => void) {
  onLoop = fn;
}

export function tickAbLoop(progress: number, _duration: number) {
  if (!state.active || state.a === null || state.b === null) return;
  if (progress >= state.b - 0.05) {
    onLoop?.(state.a);
  }
}

export const abLoopPlugin: ZenithPlugin = {
  id: 'ab-loop',
  name: 'A-B Loop',
  category: 'playback',
  description:
    'Mark two points in a track and loop between them - great for practice and sampling.',
  defaultEnabled: false,
  onTrackChange() {
    clearAbLoop();
  },
};
