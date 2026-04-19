const SIZE = 40;
const done = new Map<string, string | null>();
const busy = new Map<string, Promise<string | null>>();

function boxBlur(px: Uint8ClampedArray, w: number, h: number, r: number) {
  const tmp = new Float32Array(px.length);
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          sum += px[(y * w + xx) * 4 + c];
        }
        tmp[(y * w + x) * 4 + c] = sum / span;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          sum += tmp[(yy * w + x) * 4 + c];
        }
        px[(y * w + x) * 4 + c] = sum / span;
      }
    }
  }
}

export function blurPixels(px: Uint8ClampedArray, w: number, h: number, saturate = 1.35) {
  for (let i = 0; i < 3; i++) boxBlur(px, w, h, 2);
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    px[i] = l + (px[i] - l) * saturate;
    px[i + 1] = l + (px[i + 1] - l) * saturate;
    px[i + 2] = l + (px[i + 2] - l) * saturate;
  }
}

function load(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const data = ctx.getImageData(0, 0, SIZE, SIZE);
        blurPixels(data.data, SIZE, SIZE);
        ctx.putImageData(data, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        console.debug('[zenith] pre-blur skipped', e);
        resolve(null);
      }
    };
    img.src = url;
  });
}

export function preBlurred(url: string): string | null | undefined {
  return done.get(url);
}

export function preBlur(urls: string[]): Promise<string | null> {
  const key = urls[0] || '';
  if (done.has(key)) return Promise.resolve(done.get(key) ?? null);
  const running = busy.get(key);
  if (running) return running;
  const job = (async () => {
    let out: string | null = null;
    for (const u of urls) {
      if (!u) continue;
      out = await load(u);
      if (out) break;
    }
    if (done.size > 64) done.clear();
    done.set(key, out);
    busy.delete(key);
    return out;
  })();
  busy.set(key, job);
  return job;
}
