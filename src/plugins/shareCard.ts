import { cachedCoverUrl } from '../utils/covers';
import { NowPlayingInfo, ZenithPlugin } from './types';

export async function generateShareCard(
  info: NowPlayingInfo,
  coverImg?: HTMLImageElement | null
): Promise<Blob> {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0d0e14');
  grad.addColorStop(0.5, '#1a1030');
  grad.addColorStop(1, '#0a0b10');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // WebKit nie ma ctx.filter: bez rozmycia zostałby ostry pasek okładki zamiast poświaty
  if (coverImg && 'filter' in ctx) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.filter = 'blur(60px)';
    ctx.drawImage(coverImg, W / 2 - 200, 120, 400, 400);
    ctx.restore();
  }

  const coverSize = 480;
  const coverX = (W - coverSize) / 2;
  const coverY = 140;
  if (coverImg) {
    ctx.save();
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 28);
    ctx.clip();
    ctx.drawImage(coverImg, coverX, coverY, coverSize, coverSize);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 28);
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 28);
    ctx.fill();
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 52px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  // dwa wiersze tytułu i wykonawca pod ostatnim, żeby nic nie wchodziło na pasek postępu
  const titleEnd = wrapText(ctx, info.title, W / 2, coverY + coverSize + 80, W - 120, 60, 2);

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '600 32px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(fitLine(ctx, info.artist, W - 160), W / 2, titleEnd + 64);

  const barY = H - 180;
  const barW = W - 160;
  const pct = info.duration > 0 ? info.position / info.duration : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 80, barY, barW, 8, 4);
  ctx.fill();
  const fillGrad = ctx.createLinearGradient(80, 0, 80 + barW, 0);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-1').trim();
  fillGrad.addColorStop(0, accent || '#a78bfa');
  fillGrad.addColorStop(1, '#fff');
  ctx.fillStyle = fillGrad;
  roundRect(ctx, 80, barY, barW * pct, 8, 4);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '800 22px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('Z E N I T H', W / 2, H - 80);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob failed'))), 'image/png');
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

type TextCtx = Pick<CanvasRenderingContext2D, 'measureText' | 'fillText'>;

/** Najwyżej maxLines wierszy, nadmiar kończy wielokropek; zwraca linię bazową ostatniego wiersza. */
export function wrapText(
  ctx: TextCtx,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number
): number {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  lines.push(line);
  const shown = lines.slice(0, maxLines);
  shown[shown.length - 1] = lines.slice(shown.length - 1).join(' ');
  shown.forEach((l, i) => ctx.fillText(fitLine(ctx, l, maxW), x, y + i * lineH));
  return y + (shown.length - 1) * lineH;
}

export function fitLine(ctx: TextCtx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let cut = text;
  while (cut && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export async function copyShareCardToClipboard(info: NowPlayingInfo): Promise<boolean> {
  let img: HTMLImageElement | null = null;
  if (info.coverUrl) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((res) => {
      img!.onload = () => res();
      img!.onerror = () => res();
      img!.src = cachedCoverUrl(info.coverUrl!, 544);
    });
    // drawImage rzuca wyjątek na uszkodzonym obrazku, wtedy karta wychodzi bez okładki
    if (!img.naturalWidth) img = null;
  }
  let blob: Blob;
  try {
    blob = await generateShareCard(info, img);
  } catch {
    return false;
  }
  // schowek webview odmawia, gdy okno nie ma fokusu albo minął gest, Tauri pisze do systemu bez tych warunków
  try {
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeImage(new Uint8Array(await blob.arrayBuffer()));
    return true;
  } catch {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }
}

export const shareCardPlugin: ZenithPlugin = {
  id: 'share-card',
  name: 'Share card',
  category: 'integrations',
  description: 'Makes a 1080×1080 Now Playing card and copies it to the clipboard.',
  defaultEnabled: false,
};
