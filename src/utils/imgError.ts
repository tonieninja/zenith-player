const FALLBACK_AVATAR =
  'https://ui-avatars.com/api/?name=?&background=111827&color=6b7280&size=240';

const YTIMG = 'https://i.ytimg.com/vi/';

export function isYouTubeVideoId(id: string | undefined | null): boolean {
  return !!id && /^[\w-]{11}$/.test(id);
}

type CoverTrack = {
  id: string;
  cover?: string;
  coverSmall?: string;
  coverLarge?: string;
};

export function coverAttrs(track: CoverTrack, size: 'small' | 'large' = 'small') {
  const src =
    size === 'large'
      ? track.coverLarge || track.cover || track.coverSmall || ''
      : track.coverSmall || track.cover || track.coverLarge || '';
  return {
    src,
    onError: imgErr,
    ...(isYouTubeVideoId(track.id) ? { 'data-video-id': track.id } : {}),
  };
}

export function imgErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.coverFail === '1') return;

  const src = el.getAttribute('src') || el.src || '';
  const videoId = el.dataset.videoId || '';

  if (src.includes('maxresdefault')) {
    el.src = src.replace('maxresdefault', 'hqdefault');
    return;
  }

  const size = src.match(/=w(\d+)-h\d+/i);
  if (size) {
    const w = Number(size[1]);
    if (w > 544) {
      el.src = src.replace(/=w\d+-h\d+/i, '=w544-h544');
      return;
    }
    if (w > 226) {
      el.src = src.replace(/=w\d+-h\d+/i, '=w226-h226');
      return;
    }
  }

  const sSize = src.match(/=s(\d+)/i);
  if (sSize && Number(sSize[1]) > 226) {
    el.src = src.replace(/=s\d+/i, '=s226');
    return;
  }

  if (src.includes('hqdefault')) {
    el.src = src.replace('hqdefault', 'mqdefault');
    return;
  }
  if (src.includes('mqdefault')) {
    el.src = src.replace('mqdefault', 'default');
    return;
  }

  if (videoId && !src.includes(`/vi/${videoId}/`)) {
    el.src = `${YTIMG}${videoId}/hqdefault.jpg`;
    return;
  }

  el.dataset.coverFail = '1';
  if (!src.includes('ui-avatars')) {
    el.src = FALLBACK_AVATAR;
  }
}
