import { getCurrentWindow } from '@tauri-apps/api/window';

/** window minimized, skip the heavy gpu blur stuff */
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

/** webview2 likes to hang if you slam backdrop-filter back on mid-composite */
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
      unlistenFocus = fn;
    });

  void win
    .onResized(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        void syncWindowOcclusion();
      });
    })
    .then((fn) => {
      unlistenResize = fn;
    });

  return () => {
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

/** debounce maximize, resize storms during min/restore freeze webview2 ipc */
export function installMaximizeStateHandler(setMaximized: (v: boolean) => void): () => void {
  const win = getCurrentWindow();
  let unlisten: (() => void) | undefined;

  const sync = () => {
    if (maximizePending) return;
    maximizePending = true;
    void win.isMaximized().then((max) => {
      maximizePending = false;
      setMaximized(max);
    });
  };

  void win.isMaximized().then(setMaximized);

  void win
    .onResized(() => {
      if (maximizeRaf) cancelAnimationFrame(maximizeRaf);
      maximizeRaf = requestAnimationFrame(() => {
        maximizeRaf = 0;
        sync();
      });
    })
    .then((fn) => {
      unlisten = fn;
    });

  return () => {
    unlisten?.();
    if (maximizeRaf) cancelAnimationFrame(maximizeRaf);
  };
}
