// Shared canvas compositing: draws 4 photos into a frame layout's slots,
// then draws the frame image on top (transparent photo windows), with an
// optional CSS filter applied to the photo layer.

import { getLayout } from './layouts.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * Draws `img` into the rect (x, y, w, h) using "cover" fit (crop to fill,
 * preserve aspect ratio, centered).
 */
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const drawW = iw * scale;
  const drawH = ih * scale;
  const dx = x + (w - drawW) / 2;
  const dy = y + (h - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

/**
 * Composites 4 photos + a frame overlay onto `canvas` at print resolution.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {'strip'|'grid'} opts.layoutName
 * @param {string[]} opts.photoUrls - exactly 4 photo URLs, in slot order
 * @param {string} opts.frameUrl - frame overlay image URL (PNG/SVG)
 * @param {string} [opts.filterCss] - CSS filter string, e.g. "grayscale(1)"
 */
export async function composeFrame({ canvas, layoutName, photoUrls, frameUrl, filterCss }) {
  const layout = getLayout(layoutName);
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  const [photos, frameImg] = await Promise.all([
    Promise.all(photoUrls.map(loadImage)),
    loadImage(frameUrl),
  ]);

  ctx.save();
  ctx.filter = filterCss && filterCss !== 'none' ? filterCss : 'none';
  layout.slots.forEach((slot, i) => {
    const img = photos[i];
    if (!img) return;
    drawCover(ctx, img, slot.x, slot.y, slot.w, slot.h);
  });
  ctx.restore();

  // Frame drawn on top, without the filter, at full canvas size.
  ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);

  return canvas;
}

export function canvasToJpegBlob(canvas, quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}
