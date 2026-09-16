const DEFAULT = {
  accent: '#7eb4ff',
  accent2: '#4d8cff',
  glow: 'rgba(77, 140, 255, 0.28)',
  mesh1: 'rgba(77, 140, 255, 0.12)',
  mesh2: 'rgba(126, 180, 255, 0.06)',
};

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

function applyVars(accent: string, accent2: string, glow: string, mesh1: string, mesh2: string) {
  const root = document.documentElement;
  root.style.setProperty('--theme-accent', accent);
  root.style.setProperty('--theme-accent-2', accent2);
  root.style.setProperty('--accent-1', accent);
  root.style.setProperty('--accent-2', accent2);
  root.style.setProperty('--accent-glow', glow);
  root.style.setProperty('--theme-mesh-1', mesh1);
  root.style.setProperty('--theme-mesh-2', mesh2);
  root.classList.add('has-cover-theme');
}

export function resetCoverTheme() {
  applyVars(DEFAULT.accent, DEFAULT.accent2, DEFAULT.glow, DEFAULT.mesh1, DEFAULT.mesh2);
  document.documentElement.classList.remove('has-cover-theme');
  (document.querySelector('.zenith-app') as HTMLElement | null)?.style.removeProperty(
    '--ambient-color'
  );
}

let themeJob = 0;

export function applyCoverTheme(coverUrl: string | undefined | null) {
  if (!coverUrl) {
    resetCoverTheme();
    return;
  }
  const job = ++themeJob;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    if (job !== themeJob) return;
    try {
      const canvas = document.createElement('canvas');
      const size = 32;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const pr = data[i];
        const pg = data[i + 1];
        const pb = data[i + 2];
        const pa = data[i + 3];
        if (pa < 40) continue;
        const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
        if (lum < 24 || lum > 230) continue;
        r += pr;
        g += pg;
        b += pb;
        n += 1;
      }
      if (!n) return;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      const accent = rgbToHex(mix(r, 255, 0.15), mix(g, 255, 0.12), mix(b, 255, 0.1));
      const accent2 = rgbToHex(mix(r, 0, 0.25), mix(g, 0, 0.25), mix(b, 0, 0.25));
      applyVars(
        accent,
        accent2,
        `rgba(${r}, ${g}, ${b}, 0.32)`,
        `rgba(${r}, ${g}, ${b}, 0.14)`,
        `rgba(${mix(r, 255, 0.3)}, ${mix(g, 255, 0.3)}, ${mix(b, 255, 0.3)}, 0.07)`
      );
      const app = document.querySelector('.zenith-app') as HTMLElement | null;
      app?.style.setProperty('--ambient-color', `rgb(${r}, ${g}, ${b})`);
    } catch {
      /* cors ate the canvas, keep the old colors */
      /* cors znowu zjebal canvas, stare kolory zostaja i nie recze sie */
    }
  };
  img.onerror = () => {
    if (job === themeJob) resetCoverTheme();
  };
  img.src = coverUrl;
}
