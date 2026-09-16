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

  // bg gradient
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0d0e14');
  grad.addColorStop(0.5, '#1a1030');
  grad.addColorStop(1, '#0a0b10');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // glow off the cover
  if (coverImg) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.filter = 'blur(60px)';
    ctx.drawImage(coverImg, W / 2 - 200, 120, 400, 400);
    ctx.restore();
  }

  // cover
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

  // title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 52px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  wrapText(ctx, info.title, W / 2, coverY + coverSize + 80, W - 120, 60);

  // artist
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '600 32px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(info.artist, W / 2, coverY + coverSize + 160);

  // progress
  const barY = H - 180;
  const barW = W - 160;
  const pct = info.duration > 0 ? info.position / info.duration : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 80, barY, barW, 8, 4);
  ctx.fill();
  const fillGrad = ctx.createLinearGradient(80, 0, 80 + barW, 0);
  fillGrad.addColorStop(0, '#a78bfa');
  fillGrad.addColorStop(1, '#fff');
  ctx.fillStyle = fillGrad;
  roundRect(ctx, 80, barY, barW * pct, 8, 4);
  ctx.fill();

  // zenith branding, tiny
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

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number
) {
  const words = text.split(' ');
  let line = '';
  let cy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      line = word;
      cy += lineH;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, cy);
}

export async function copyShareCardToClipboard(info: NowPlayingInfo): Promise<boolean> {
  let img: HTMLImageElement | null = null;
  if (info.coverUrl) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((res) => {
      img!.onload = () => res();
      img!.onerror = () => res();
      img!.src = info.coverUrl!;
    });
  }
  const blob = await generateShareCard(info, img);
  try {
    if (navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
  } catch {}
  try {
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    const buffer = await blob.arrayBuffer();
    await writeImage(new Uint8Array(buffer));
    return true;
  } catch {
    return false;
  }
}

export const shareCardPlugin: ZenithPlugin = {
  id: 'share-card',
  name: 'Share Card',
  category: 'social',
  description: 'Generate a gorgeous 1080×1080 Now Playing card and copy it to your clipboard.',
  defaultEnabled: false,
};
