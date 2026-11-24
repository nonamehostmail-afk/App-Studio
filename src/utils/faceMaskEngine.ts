import type { FaceMaskType } from '../types/translator';

/**
 * Normalized face bounding box in [0, 1] viewport coordinates.
 */
export interface NormalizedFaceBox {
  cx: number; // horizontal center 0..1
  cy: number; // vertical center 0..1
  w: number; // width fraction 0..1
  h: number; // height fraction 0..1
  confidence: number; // 0..1
}

export interface FaceMaskRenderOptions {
  type: FaceMaskType;
  scale: number;
  offsetY: number;
  opacity: number;
  customImage?: HTMLImageElement | null;
}

export const DEFAULT_CENTER_FACE: NormalizedFaceBox = {
  cx: 0.5,
  cy: 0.44,
  w: 0.24,
  h: 0.42,
  confidence: 0.5,
};

/**
 * Smoothly interpolates between previous and newly detected face boxes
 * to eliminate mask jitter during live webcam or video playback.
 */
export function smoothFaceBox(
  prev: NormalizedFaceBox | null,
  next: NormalizedFaceBox,
  alpha = 0.28,
): NormalizedFaceBox {
  if (!prev) return { ...next };
  const clampedAlpha = Math.max(0.05, Math.min(1, alpha));
  return {
    cx: prev.cx + (next.cx - prev.cx) * clampedAlpha,
    cy: prev.cy + (next.cy - prev.cy) * clampedAlpha,
    w: prev.w + (next.w - prev.w) * clampedAlpha,
    h: prev.h + (next.h - prev.h) * clampedAlpha,
    confidence: next.confidence,
  };
}

/**
 * Pure TypeScript real-time skin-chrominance face blob detector on RGBA pixel buffers
 * (e.g. 96x54 downsampled frame). Uses YCbCr skin gamut + upper/central spatial prior
 * and connected-cluster bounding refinement with zero external CDN dependencies.
 */
export function detectFaceFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): NormalizedFaceBox | null {
  if (width < 16 || height < 16 || rgba.length < width * height * 4) {
    return null;
  }

  const mask = new Uint8Array(width * height);
  let totalSkin = 0;

  // Step 1: YCbCr skin-tone chrominance segmentation (broad across skin tones)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];

      const yVal = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      const isSkin =
        yVal > 42 &&
        yVal < 245 &&
        cb >= 76 &&
        cb <= 128 &&
        cr >= 132 &&
        cr <= 176 &&
        r > b &&
        r - Math.min(g, b) > 12;

      if (isSkin) {
        mask[y * width + x] = 1;
        totalSkin++;
      }
    }
  }

  const minPixels = Math.max(12, Math.floor(width * height * 0.012));
  if (totalSkin < minPixels) {
    return null;
  }

  // Step 2: Connected-component labeling (4-connectivity) to isolate the primary face blob
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);

  let bestScore = -1;
  let bestBox: NormalizedFaceBox | null = null;

  for (let start = 0; start < width * height; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % width;
      const cy = Math.floor(curr / width);
      count++;
      sumX += cx;
      sumY += cy;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      // 4 neighbors
      if (cx > 0) {
        const n = curr - 1;
        if (mask[n] === 1 && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (cx + 1 < width) {
        const n = curr + 1;
        if (mask[n] === 1 && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (cy > 0) {
        const n = curr - width;
        if (mask[n] === 1 && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
      if (cy + 1 < height) {
        const n = curr + width;
        if (mask[n] === 1 && !visited[n]) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
    }

    if (count < minPixels) continue;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const normW = bw / width;
    const normH = bh / height;
    if (normW < 0.06 || normH < 0.1 || normW > 0.78 || normH > 0.92) continue;

    const fillDensity = count / (bw * bh);
    if (fillDensity < 0.28) continue;

    // Human faces usually sit in upper-middle half and have compact aspect ratio
    const normCx = sumX / count / width;
    const normCy = sumY / count / height;
    const aspect = bw / bh;
    const aspectPenalty = Math.abs(aspect - 0.85);
    const centerBias = 1 - Math.abs(normCx - 0.5) * 0.45 - Math.max(0, normCy - 0.55) * 0.5;
    const score = count * fillDensity * Math.max(0.2, 1.3 - aspectPenalty) * Math.max(0.3, centerBias);

    if (score > bestScore) {
      bestScore = score;
      // Pad slightly so forehead & chin are covered nicely by face masks
      const paddedW = Math.min(0.65, Math.max(0.14, normW * 1.15));
      const paddedH = Math.min(0.85, Math.max(0.22, normH * 1.18));
      bestBox = {
        cx: Math.max(0.08, Math.min(0.92, normCx)),
        cy: Math.max(0.08, Math.min(0.88, normCy)),
        w: paddedW,
        h: paddedH,
        confidence: Math.min(1, fillDensity * 1.35),
      };
    }
  }

  return bestBox;
}

/**
 * Formats seconds into MM:SS playback timecode.
 */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Renders the selected real-time face mask onto the Canvas2D frame processor output.
 * Works identically on live webcam, OBS Virtual Camera, uploaded video files, and demo studio camera.
 */
export function renderFaceMaskOnCanvas(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  box: NormalizedFaceBox,
  options: FaceMaskRenderOptions,
  pixelHelperCanvas?: HTMLCanvasElement,
): void {
  if (options.type === 'none') return;

  const cw = sourceCanvas.width;
  const ch = sourceCanvas.height;
  if (cw === 0 || ch === 0) return;

  const scale = Math.max(0.4, Math.min(2.2, options.scale));
  const opacity = Math.max(0.15, Math.min(1, options.opacity));

  const cx = box.cx * cw;
  const cy = (box.cy + options.offsetY * 0.35) * ch;
  const fw = box.w * cw * scale;
  const fh = box.h * ch * scale;
  const rx = fw * 0.52;
  const ry = fh * 0.54;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (options.type === 'blur_privacy') {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.filter = `blur(${Math.max(10, Math.round(fw * 0.085))}px)`;
    ctx.drawImage(sourceCanvas, 0, 0, cw, ch);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(11, 14, 20, 0.16)';
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
    ctx.restore();

    // Subtle crisp studio privacy perimeter
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (options.type === 'pixel_censor') {
    const sx = Math.max(0, Math.floor(cx - rx));
    const sy = Math.max(0, Math.floor(cy - ry));
    const sw = Math.max(8, Math.min(cw - sx, Math.ceil(rx * 2)));
    const sh = Math.max(8, Math.min(ch - sy, Math.ceil(ry * 2)));

    const helper = pixelHelperCanvas || document.createElement('canvas');
    const blocksX = 14;
    const blocksY = Math.max(10, Math.round((blocksX * sh) / sw));
    helper.width = blocksX;
    helper.height = blocksY;
    const hCtx = helper.getContext('2d');
    if (hCtx) {
      hCtx.imageSmoothingEnabled = false;
      hCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, blocksX, blocksY);

      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(helper, 0, 0, blocksX, blocksY, sx, sy, sw, sh);
    }
    ctx.restore();
    return;
  }

  if (options.type === 'custom_png' && options.customImage && options.customImage.complete && options.customImage.naturalWidth > 0) {
    const img = options.customImage;
    const imgAspect = img.naturalWidth / img.naturalHeight;
    let drawW = fw * 1.15;
    let drawH = drawW / imgAspect;
    if (drawH < fh * 0.9) {
      drawH = fh * 1.05;
      drawW = drawH * imgAspect;
    }
    ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();
    return;
  }

  if (options.type === 'cyber_visor') {
    const eyeY = cy - fh * 0.1;
    const visorW = fw * 0.96;
    const visorH = fh * 0.34;
    const x0 = cx - visorW / 2;
    const y0 = eyeY - visorH / 2;

    // Visor body (matte dark broadcast titanium)
    const grad = ctx.createLinearGradient(x0, y0, x0, y0 + visorH);
    grad.addColorStop(0, '#1E2538');
    grad.addColorStop(0.5, '#090C14');
    grad.addColorStop(1, '#151B2B');

    ctx.beginPath();
    ctx.moveTo(x0 + visorW * 0.08, y0);
    ctx.lineTo(x0 + visorW * 0.92, y0);
    ctx.lineTo(x0 + visorW, y0 + visorH * 0.42);
    ctx.lineTo(x0 + visorW * 0.86, y0 + visorH);
    ctx.lineTo(x0 + visorW * 0.56, y0 + visorH);
    ctx.lineTo(cx, y0 + visorH * 0.72);
    ctx.lineTo(x0 + visorW * 0.44, y0 + visorH);
    ctx.lineTo(x0 + visorW * 0.14, y0 + visorH);
    ctx.lineTo(x0, y0 + visorH * 0.42);
    ctx.closePath();

    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 29, 72, 0.85)';
    ctx.lineWidth = Math.max(2, fw * 0.015);
    ctx.stroke();

    // Crimson scanning optics line
    ctx.strokeStyle = '#FB7185';
    ctx.lineWidth = Math.max(2, fw * 0.018);
    ctx.beginPath();
    ctx.moveTo(x0 + visorW * 0.12, eyeY);
    ctx.lineTo(x0 + visorW * 0.88, eyeY);
    ctx.stroke();

    // Subtle specular glass highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1.5, fw * 0.01);
    ctx.beginPath();
    ctx.moveTo(x0 + visorW * 0.16, y0 + visorH * 0.2);
    ctx.lineTo(x0 + visorW * 0.45, y0 + visorH * 0.2);
    ctx.stroke();

    ctx.restore();
    return;
  }

  if (options.type === 'aviator_shades') {
    const eyeY = cy - fh * 0.1;
    const lensW = fw * 0.38;
    const lensH = fh * 0.25;
    const gap = fw * 0.06;

    const drawLens = (leftX: number) => {
      ctx.beginPath();
      ctx.roundRect(leftX, eyeY - lensH * 0.48, lensW, lensH, [
        lensW * 0.18,
        lensW * 0.18,
        lensW * 0.45,
        lensW * 0.45,
      ]);
      const g = ctx.createLinearGradient(
        leftX,
        eyeY - lensH * 0.5,
        leftX + lensW,
        eyeY + lensH * 0.5,
      );
      g.addColorStop(0, '#182030');
      g.addColorStop(0.45, '#07090F');
      g.addColorStop(1, '#111827');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = Math.max(2, fw * 0.014);
      ctx.stroke();

      // Specular streak
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = Math.max(1.5, fw * 0.012);
      ctx.beginPath();
      ctx.moveTo(leftX + lensW * 0.18, eyeY - lensH * 0.26);
      ctx.lineTo(leftX + lensW * 0.55, eyeY - lensH * 0.26);
      ctx.stroke();
    };

    drawLens(cx - gap / 2 - lensW);
    drawLens(cx + gap / 2);

    // Double bridge bar
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = Math.max(2, fw * 0.014);
    ctx.beginPath();
    ctx.moveTo(cx - gap * 0.8, eyeY - lensH * 0.36);
    ctx.lineTo(cx + gap * 0.8, eyeY - lensH * 0.36);
    ctx.moveTo(cx - gap * 0.6, eyeY - lensH * 0.12);
    ctx.lineTo(cx + gap * 0.6, eyeY - lensH * 0.12);
    ctx.stroke();

    ctx.restore();
    return;
  }

  if (options.type === 'fox_kit') {
    // Japanese Kitsune VTuber mask
    const topY = cy - fh * 0.48;
    const botY = cy + fh * 0.48;

    // Ears
    const drawEar = (dir: -1 | 1) => {
      ctx.beginPath();
      ctx.moveTo(cx + dir * fw * 0.14, topY + fh * 0.14);
      ctx.lineTo(cx + dir * fw * 0.46, topY - fh * 0.24);
      ctx.lineTo(cx + dir * fw * 0.48, topY + fh * 0.28);
      ctx.closePath();
      ctx.fillStyle = '#F8FAFC';
      ctx.fill();
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = Math.max(2, fw * 0.014);
      ctx.stroke();

      // Inner crimson ear accent
      ctx.beginPath();
      ctx.moveTo(cx + dir * fw * 0.24, topY + fh * 0.13);
      ctx.lineTo(cx + dir * fw * 0.41, topY - fh * 0.1);
      ctx.lineTo(cx + dir * fw * 0.42, topY + fh * 0.2);
      ctx.closePath();
      ctx.fillStyle = '#E11D48';
      ctx.fill();
    };
    drawEar(-1);
    drawEar(1);

    // Main porcelain fox face shield
    ctx.beginPath();
    ctx.moveTo(cx, topY + fh * 0.05);
    ctx.bezierCurveTo(
      cx + fw * 0.52,
      topY + fh * 0.05,
      cx + fw * 0.56,
      cy + fh * 0.08,
      cx,
      botY,
    );
    ctx.bezierCurveTo(
      cx - fw * 0.56,
      cy + fh * 0.08,
      cx - fw * 0.52,
      topY + fh * 0.05,
      cx,
      topY + fh * 0.05,
    );
    ctx.closePath();
    ctx.fillStyle = '#F1F5F9';
    ctx.fill();
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = Math.max(2, fw * 0.016);
    ctx.stroke();

    // Forehead crimson emblem
    ctx.fillStyle = '#E11D48';
    ctx.beginPath();
    ctx.moveTo(cx, topY + fh * 0.14);
    ctx.lineTo(cx + fw * 0.07, topY + fh * 0.24);
    ctx.lineTo(cx, topY + fh * 0.32);
    ctx.lineTo(cx - fw * 0.07, topY + fh * 0.24);
    ctx.closePath();
    ctx.fill();

    // Expressive slanted fox eyes + crimson eyeliner
    for (const dir of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + dir * fw * 0.1, cy - fh * 0.05);
      ctx.quadraticCurveTo(
        cx + dir * fw * 0.24,
        cy - fh * 0.15,
        cx + dir * fw * 0.36,
        cy - fh * 0.12,
      );
      ctx.quadraticCurveTo(
        cx + dir * fw * 0.24,
        cy + fh * 0.02,
        cx + dir * fw * 0.1,
        cy - fh * 0.05,
      );
      ctx.fillStyle = '#0B0E14';
      ctx.fill();
      ctx.strokeStyle = '#E11D48';
      ctx.lineWidth = Math.max(2, fw * 0.015);
      ctx.stroke();

      // Cheek whiskers
      ctx.strokeStyle = '#E11D48';
      ctx.lineWidth = Math.max(2, fw * 0.014);
      ctx.beginPath();
      ctx.moveTo(cx + dir * fw * 0.22, cy + fh * 0.12);
      ctx.lineTo(cx + dir * fw * 0.38, cy + fh * 0.08);
      ctx.moveTo(cx + dir * fw * 0.2, cy + fh * 0.19);
      ctx.lineTo(cx + dir * fw * 0.34, cy + fh * 0.17);
      ctx.stroke();
    }

    // Nose tip
    ctx.fillStyle = '#0B0E14';
    ctx.beginPath();
    ctx.moveTo(cx - fw * 0.06, cy + fh * 0.33);
    ctx.lineTo(cx + fw * 0.06, cy + fh * 0.33);
    ctx.lineTo(cx, cy + fh * 0.4);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
    return;
  }

  if (options.type === 'neon_anon') {
    // Dark Obsidian Geometric Anonymous Shield Mask
    const topY = cy - fh * 0.48;
    const botY = cy + fh * 0.48;

    ctx.beginPath();
    ctx.moveTo(cx, topY);
    ctx.lineTo(cx + fw * 0.42, topY + fh * 0.14);
    ctx.lineTo(cx + fw * 0.48, cy + fh * 0.04);
    ctx.lineTo(cx + fw * 0.3, botY - fh * 0.1);
    ctx.lineTo(cx, botY);
    ctx.lineTo(cx - fw * 0.3, botY - fh * 0.1);
    ctx.lineTo(cx - fw * 0.48, cy + fh * 0.04);
    ctx.lineTo(cx - fw * 0.42, topY + fh * 0.14);
    ctx.closePath();

    const g = ctx.createLinearGradient(cx - rx, topY, cx + rx, botY);
    g.addColorStop(0, '#1B2233');
    g.addColorStop(0.5, '#0D111B');
    g.addColorStop(1, '#141B29');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.55)';
    ctx.lineWidth = Math.max(2, fw * 0.015);
    ctx.stroke();

    // Central facet seam
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, topY + fh * 0.04);
    ctx.lineTo(cx, botY - fh * 0.04);
    ctx.stroke();

    // Sharp eye cutouts + glowing brows
    for (const dir of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + dir * fw * 0.09, cy - fh * 0.06);
      ctx.lineTo(cx + dir * fw * 0.34, cy - fh * 0.14);
      ctx.lineTo(cx + dir * fw * 0.3, cy - fh * 0.02);
      ctx.lineTo(cx + dir * fw * 0.11, cy);
      ctx.closePath();
      ctx.fillStyle = '#E11D48';
      ctx.fill();
    }

    // Minimalist chin vent bars
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.lineWidth = Math.max(2, fw * 0.014);
    ctx.beginPath();
    ctx.moveTo(cx - fw * 0.16, cy + fh * 0.22);
    ctx.lineTo(cx + fw * 0.16, cy + fh * 0.22);
    ctx.moveTo(cx - fw * 0.11, cy + fh * 0.3);
    ctx.lineTo(cx + fw * 0.11, cy + fh * 0.3);
    ctx.stroke();

    ctx.restore();
  }
}
