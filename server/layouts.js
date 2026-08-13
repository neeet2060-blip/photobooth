'use strict';

/**
 * Layout geometry constants shared between server and browser.
 *
 * IMPORTANT: This file and public/shared/layouts.js must stay numerically
 * identical. This one is CommonJS (used by server/*.js), the other is an
 * ES module (used by browser pages). If you change a number here, change
 * it there too.
 */

const STRIP_CANVAS_WIDTH = 1200;
const STRIP_CANVAS_HEIGHT = 3600;
const STRIP_SLOT_WIDTH = 1050;
const STRIP_SLOT_HEIGHT = 780;
const STRIP_SLOT_X = 75;
const STRIP_SLOT_Y0 = 75;
const STRIP_SLOT_STEP = 855;

const STRIP_SLOTS = [0, 1, 2, 3].map((i) => ({
  x: STRIP_SLOT_X,
  y: STRIP_SLOT_Y0 + i * STRIP_SLOT_STEP,
  w: STRIP_SLOT_WIDTH,
  h: STRIP_SLOT_HEIGHT,
}));

const GRID_CANVAS_WIDTH = 2400;
const GRID_CANVAS_HEIGHT = 2400;
const GRID_MARGIN = 75;
const GRID_GAP = 60;
const GRID_SLOT_WIDTH = 1095;
const GRID_SLOT_HEIGHT = 1095;

const GRID_COL_X = [GRID_MARGIN, GRID_MARGIN + GRID_SLOT_WIDTH + GRID_GAP];
const GRID_ROW_Y = [GRID_MARGIN, GRID_MARGIN + GRID_SLOT_HEIGHT + GRID_GAP];

const GRID_SLOTS = [
  { x: GRID_COL_X[0], y: GRID_ROW_Y[0], w: GRID_SLOT_WIDTH, h: GRID_SLOT_HEIGHT },
  { x: GRID_COL_X[1], y: GRID_ROW_Y[0], w: GRID_SLOT_WIDTH, h: GRID_SLOT_HEIGHT },
  { x: GRID_COL_X[0], y: GRID_ROW_Y[1], w: GRID_SLOT_WIDTH, h: GRID_SLOT_HEIGHT },
  { x: GRID_COL_X[1], y: GRID_ROW_Y[1], w: GRID_SLOT_WIDTH, h: GRID_SLOT_HEIGHT },
];

// grid2a/grid2b (2026-08-11) — native-resolution 2x2 layouts sized to match
// the real photo paper stock on hand (Sigel IP718, 10x15cm = 4x6in, a 2:3
// ratio). 1024x1536 is exactly 2:3, so unlike 'grid' (1:1, needs white
// space + caption to fill a 4x6 print) these fill the print sheet edge to
// edge. Each entry's slots were measured directly from that specific frame
// artwork's transparent photo windows — the two frames were NOT drawn to
// share one coordinate system, so they get separate layout entries rather
// than one shared 'grid2'.
const CARD_CANVAS_WIDTH = 1024;
const CARD_CANVAS_HEIGHT = 1536;

const CARD_A_SLOTS = [
  { x: 119, y: 402, w: 362, h: 353 },
  { x: 544, y: 402, w: 365, h: 353 },
  { x: 119, y: 818, w: 362, h: 464 },
  { x: 544, y: 818, w: 365, h: 464 },
];

const CARD_B_SLOTS = [
  { x: 54, y: 326, w: 440, h: 514 },
  { x: 520, y: 326, w: 441, h: 514 },
  { x: 54, y: 865, w: 441, h: 504 },
  { x: 520, y: 865, w: 441, h: 504 },
];

// grid2c: Taste of Korea 2026 blue 2x2 frame. Its photo windows sit higher
// and are taller than the other 4x6 designs, so it needs its own geometry.
const CARD_C_SLOTS = [
  { x: 67, y: 169, w: 387, h: 542 },
  { x: 569, y: 169, w: 389, h: 542 },
  { x: 67, y: 758, w: 387, h: 550 },
  { x: 569, y: 758, w: 389, h: 550 },
];

// grid2d: holographic Taste of Korea 2026 2x2 frame (2026-08-13). Its
// source artwork is 1240x1748 (not the 1024x1536 the other card layouts
// share) so this uses its own canvas size instead of CARD_CANVAS_WIDTH/
// HEIGHT — that native size is a hair off true 4x6 (2:3), so the print
// sheet stretches it ~6% vertically; visually fine for a decorative frame,
// but a future redesign should target an exact 2:3 canvas (e.g. 1200x1800)
// to avoid that. Slot rects were measured directly from the artwork's own
// alpha channel (its 4 photo windows are real transparent cutouts, unlike
// grid2c's which had to be punched in after the fact).
const CARD_D_CANVAS_WIDTH = 1240;
const CARD_D_CANVAS_HEIGHT = 1748;
const CARD_D_SLOTS = [
  { x: 125, y: 407, w: 429, h: 369 },
  { x: 672, y: 395, w: 447, h: 390 },
  { x: 129, y: 966, w: 430, h: 364 },
  { x: 683, y: 961, w: 421, h: 359 },
];

const LAYOUTS = {
  strip: {
    canvasWidth: STRIP_CANVAS_WIDTH,
    canvasHeight: STRIP_CANVAS_HEIGHT,
    slots: STRIP_SLOTS,
  },
  grid: {
    canvasWidth: GRID_CANVAS_WIDTH,
    canvasHeight: GRID_CANVAS_HEIGHT,
    slots: GRID_SLOTS,
  },
  grid2a: {
    canvasWidth: CARD_CANVAS_WIDTH,
    canvasHeight: CARD_CANVAS_HEIGHT,
    slots: CARD_A_SLOTS,
  },
  grid2b: {
    canvasWidth: CARD_CANVAS_WIDTH,
    canvasHeight: CARD_CANVAS_HEIGHT,
    slots: CARD_B_SLOTS,
  },
  grid2c: {
    canvasWidth: CARD_CANVAS_WIDTH,
    canvasHeight: CARD_CANVAS_HEIGHT,
    slots: CARD_C_SLOTS,
  },
  grid2d: {
    canvasWidth: CARD_D_CANVAS_WIDTH,
    canvasHeight: CARD_D_CANVAS_HEIGHT,
    slots: CARD_D_SLOTS,
  },
};

function getLayout(layoutName) {
  const layout = LAYOUTS[layoutName];
  if (!layout) {
    throw new Error(`Unknown layout: ${layoutName}`);
  }
  return layout;
}

module.exports = { LAYOUTS, getLayout };
