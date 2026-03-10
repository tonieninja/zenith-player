export function formatTime(time: number): string {
  if (isNaN(time) || !isFinite(time) || time < 0) return '0:00';
  if (time >= 60 * 60) return 'LIVE';
  const mins = Math.floor(time / 60);
  const secs = Math.floor(time % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function knownDurationSec(
  track?: { durationSec?: number | null } | null,
  fallback = 0
): number {
  const sec = Number(track?.durationSec);
  if (Number.isFinite(sec) && sec > 0) return sec;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

export function audioOrKnownDuration(audioDuration: number, known: number): number {
  if (Number.isFinite(audioDuration) && audioDuration > 0) return audioDuration;
  return Number.isFinite(known) && known > 0 ? known : 0;
}

export function barDurationForTrack(
  trackKnownSec: number,
  audioDuration: number,
  audioBelongsToTrack: boolean
): number {
  if (audioBelongsToTrack && Number.isFinite(audioDuration) && audioDuration > 0) {
    return audioDuration;
  }
  if (Number.isFinite(trackKnownSec) && trackKnownSec > 0) return trackKnownSec;
  return 0;
}
