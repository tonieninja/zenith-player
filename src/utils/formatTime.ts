export function formatTime(time: number): string {
  if (isNaN(time) || !isFinite(time) || time < 0) return '0:00';
  // radio mixes can be 11h, dont show that nonsense
  if (time >= 60 * 60) return 'LIVE';
  const mins = Math.floor(time / 60);
  const secs = Math.floor(time % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
