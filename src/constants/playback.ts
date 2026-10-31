export const STREAM_CACHE_TTL = 20 * 60 * 1000;
export const STREAM_CACHE_LIMIT = 8;
/** tick the progress bar, throttled so we dont rerender the whole app 60 times a sec */
export const UI_PROGRESS_MS = 500;
export const MINI_PLAYER_SYNC_MS = 4000;

/** background stream warmups pause this long after any resolve failure */
export const PREFETCH_PAUSE_AFTER_FAIL_MS = 90 * 1000;
