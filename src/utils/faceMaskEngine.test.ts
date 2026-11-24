import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CENTER_FACE,
  detectFaceFromRgba,
  formatMediaTime,
  smoothFaceBox,
} from './faceMaskEngine';

test('detectFaceFromRgba locates a synthetic human skin-tone face region accurately', () => {
  const width = 96;
  const height = 54;
  const rgba = new Uint8ClampedArray(width * height * 4);

  // Fill dark studio background
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 16;
    rgba[i * 4 + 1] = 20;
    rgba[i * 4 + 2] = 30;
    rgba[i * 4 + 3] = 255;
  }

  // Paint a realistic skin-tone oval centered at (0.62, 0.42)
  const targetCx = Math.round(width * 0.62);
  const targetCy = Math.round(height * 0.42);
  const rx = 10;
  const ry = 13;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - targetCx) / rx;
      const dy = (y - targetCy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const idx = (y * width + x) * 4;
        rgba[idx] = 212;
        rgba[idx + 1] = 162;
        rgba[idx + 2] = 130;
        rgba[idx + 3] = 255;
      }
    }
  }

  const detected = detectFaceFromRgba(rgba, width, height);
  assert.ok(detected !== null, 'expected face to be detected');
  assert.ok(Math.abs(detected.cx - 0.62) < 0.05, `cx=${detected.cx}`);
  assert.ok(Math.abs(detected.cy - 0.42) < 0.06, `cy=${detected.cy}`);
  assert.ok(detected.w > 0.15 && detected.h > 0.35);
});

test('detectFaceFromRgba returns null on uniform non-skin dark frame', () => {
  const width = 64;
  const height = 36;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 20;
    rgba[i * 4 + 1] = 35;
    rgba[i * 4 + 2] = 60;
    rgba[i * 4 + 3] = 255;
  }
  assert.equal(detectFaceFromRgba(rgba, width, height), null);
});

test('smoothFaceBox interpolates coordinates smoothly without overshoot', () => {
  const next = { cx: 0.7, cy: 0.5, w: 0.3, h: 0.5, confidence: 0.9 };
  const smoothed = smoothFaceBox(DEFAULT_CENTER_FACE, next, 0.25);
  assert.ok(Math.abs(smoothed.cx - 0.55) < 1e-6);
  assert.ok(Math.abs(smoothed.cy - 0.455) < 1e-6);
  assert.equal(smoothFaceBox(null, next, 0.25).cx, 0.7);
});

test('formatMediaTime formats seconds into MM:SS cleanly', () => {
  assert.equal(formatMediaTime(0), '00:00');
  assert.equal(formatMediaTime(65.8), '01:05');
  assert.equal(formatMediaTime(-5), '00:00');
  assert.equal(formatMediaTime(Number.NaN), '00:00');
});
