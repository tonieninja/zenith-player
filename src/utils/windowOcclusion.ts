import { getCurrentWindow } from '@tauri-apps/api/window';

let occluded = false;
let resizeRaf = 0;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

const OCCLUDED_CLASS = 'window-occluded';

function applyOccluded(next: boolean) {
  if (occluded === next) return;
  occluded = next;
  document.documentElement.classList.toggle(OCCLUDED_CLASS, next);
}

export function isWindowOccluded() {
  return occluded;
}

export async function syncWindowOcclusion() {
  const win = getCurrentWindow();
  try {
    const min = await win.isMinimized();
    if (min || document.hidden) {
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      applyOccluded(true);
      return true;
    }
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      if (!document.hidden) applyOccluded(false);
    }, 220);
    return false;
  } catch {
    return occluded;
  }
}

export function installWindowOcclusionHandlers(onFocus?: (focused: boolean) => void): () => void {
  const win = getCurrentWindow();
  let unlistenFocus: (() => void) | undefined;
  let unlistenResize: (() => void) | undefined;
  let disposed = false;

  const onVisibility = () => {
    if (document.hidden) applyOccluded(true);
    else void syncWindowOcclusion();
  };

  void syncWindowOcclusion();
  document.addEventListener('visibilitychange', onVisibility);

  void win
    .onFocusChanged(({ payload: focused }) => {
      onFocus?.(focused);
      if (focused) void syncWindowOcclusion();
      else if (document.hidden) applyOccluded(true);
    })
    .then((fn) => {
      if (disposed) fn();
      else unlistenFocus = fn;
    })
    .catch((err) => console.debug('windowOcclusion installWindowOcclusionHandlers', err));

  void win
    .onResized(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        void syncWindowOcclusion();
      });
    })
    .then((fn) => {
      if (disposed) fn();
      else unlistenResize = fn;
    })
    .catch((err) => console.debug('windowOcclusion installWindowOcclusionHandlers', err));

  return () => {
    disposed = true;
    unlistenFocus?.();
    unlistenResize?.();
    document.removeEventListener('visibilitychange', onVisibility);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (restoreTimer) clearTimeout(restoreTimer);
    applyOccluded(false);
  };
}

let maximizeRaf = 0;
let maximizePending = false;

export function installMaximizeStateHandler(setMaximized: (v: boolean) => void): () => void {
  const win = getCurrentWindow();
  let unlisten: (() => void) | undefined;
  let disposed = false;

  const sync = () => {
    if (maximizePending) return;
    maximizePending = true;
    void win
      .isMaximized()
      .then((max) => {
        if (!disposed) setMaximized(max);
      })
      .catch((err) => console.debug('windowOcclusion sync', err))
      .finally(() => {
        maximizePending = false;
      });
  };

  void win
    .isMaximized()
    .then(setMaximized)
    .catch((err) => console.debug('windowOcclusion installMaximizeStateHandler', err));

  void win
    .onResized(() => {
      if (maximizeRaf) cancelAnimationFrame(maximizeRaf);
      maximizeRaf = requestAnimationFrame(() => {
        maximizeRaf = 0;
        sync();
      });
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((err) => console.debug('windowOcclusion installMaximizeStateHandler', err));

  return () => {
    disposed = true;
    unlisten?.();
    if (maximizeRaf) cancelAnimationFrame(maximizeRaf);
  };
}
