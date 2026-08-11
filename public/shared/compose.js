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
    // "cover" fit centers the image and can extend past the slot rect on one
    // axis (whichever isn't the constraining one) — without clipping, that
    // overflow paints into neighboring slots or the frame's transparent
    // margin instead of being cropped away.
    ctx.save();
    ctx.beginPath();
    ctx.rect(slot.x, slot.y, slot.w, slot.h);
    ctx.clip();
    drawCover(ctx, img, slot.x, slot.y, slot.w, slot.h);
    ctx.restore();
  });
  ctx.restore();

  // Frame drawn on top, without the filter, at full canvas size.
  ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);

  return canvas;
}

// ---- Print-ready sheet (dye-sub 4x6in @ 300dpi = 1200x1800px) ----

const PRINT_SHEET_WIDTH = 1200;
const PRINT_SHEET_HEIGHT = 1800;
const STRIP_HALF_WIDTH = 600; // each of the two side-by-side 2x6 strips
const GRID_TOP_HEIGHT = 1200; // scaled-down square, placed at the top
const CUT_LINE_DASH = [12, 10];
const CAPTION_TEXT = 'Taste of Korea';

/**
 * Composites a print-ready 1200x1800 (4x6in @ 300dpi) sheet for the dye-sub
 * printer, reusing composeFrame's screen-resolution output as the source
 * image (drawn onto an offscreen canvas, then scaled/copied here) rather
 * than duplicating its drawing logic.
 *
 * - 'strip' layouts (screen output 1200x3600) are scaled down to 600x1800
 *   and drawn twice, side by side, with a dashed cut line down the middle
 *   so staff can cut the sheet into two 2x6 strips.
 * - 'grid' layouts (screen output 2400x2400) are scaled to 1200x1200 and
 *   placed at the top; the remaining 1200x600 band is plain white with a
 *   small centered caption (no cut line).
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas - destination print canvas
 * @param {'strip'|'grid'} opts.layoutName
 * @param {string[]} opts.photoUrls
 * @param {string} opts.frameUrl
 * @param {string} [opts.filterCss]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function composePrintSheet({ canvas, layoutName, photoUrls, frameUrl, filterCss }) {
  const offscreen = document.createElement('canvas');
  await composeFrame({ canvas: offscreen, layoutName, photoUrls, frameUrl, filterCss });

  canvas.width = PRINT_SHEET_WIDTH;
  canvas.height = PRINT_SHEET_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (layoutName === 'strip') {
    ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, STRIP_HALF_WIDTH, PRINT_SHEET_HEIGHT);
    ctx.drawImage(
      offscreen,
      0,
      0,
      offscreen.width,
      offscreen.height,
      STRIP_HALF_WIDTH,
      0,
      STRIP_HALF_WIDTH,
      PRINT_SHEET_HEIGHT,
    );

    ctx.save();
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 2;
    ctx.setLineDash(CUT_LINE_DASH);
    ctx.beginPath();
    ctx.moveTo(STRIP_HALF_WIDTH, 0);
    ctx.lineTo(STRIP_HALF_WIDTH, PRINT_SHEET_HEIGHT);
    ctx.stroke();
    ctx.restore();
  } else if (layoutName === 'grid') {
    ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, GRID_TOP_HEIGHT, GRID_TOP_HEIGHT);

    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, GRID_TOP_HEIGHT, PRINT_SHEET_WIDTH, PRINT_SHEET_HEIGHT - GRID_TOP_HEIGHT);
    ctx.fillStyle = '#222';
    ctx.font = '48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(CAPTION_TEXT, PRINT_SHEET_WIDTH / 2, GRID_TOP_HEIGHT + (PRINT_SHEET_HEIGHT - GRID_TOP_HEIGHT) / 2);
    ctx.restore();
  } else {
    // 2026-08-11 — grid2a/grid2b(및 앞으로 추가될, 인화지 실물 비율에 맞춰 그려진 네이티브
    // 레이아웃)는 캔버스가 이미 정확히 인쇄 시트와 같은 2:3 비율(1024x1536 → 1200x1800, 배율
    // 1.171875로 가로세로 동일)이라 strip/grid처럼 절반씩 나누거나 여백+캡션을 넣을 필요 없이
    // 시트 전체에 그대로 꽉 채운다.
    ctx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, PRINT_SHEET_WIDTH, PRINT_SHEET_HEIGHT);
  }

  return canvas;
}

export function canvasToJpegBlob(canvas, quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}
