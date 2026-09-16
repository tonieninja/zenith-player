import type { Track } from '../api/youtube';

const primaryArtistOf = (track: Track) => track.artist.split('•')[0].trim().toLowerCase();

const cryptoRandom = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
};

/** fisher-yates plus dont put the same artist back to back if we can help it */
/** 3 razy z rzedu ten sam artysta i mnie szlak trafia */
export function smartShuffle(items: Track[]): Track[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(cryptoRandom() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  for (let i = 1; i < arr.length; i += 1) {
    if (primaryArtistOf(arr[i]) !== primaryArtistOf(arr[i - 1])) continue;
    for (let j = i + 1; j < arr.length; j += 1) {
      if (primaryArtistOf(arr[j]) !== primaryArtistOf(arr[i - 1])) {
        [arr[i], arr[j]] = [arr[j], arr[i]];
        break;
      }
    }
  }
  return arr;
}
