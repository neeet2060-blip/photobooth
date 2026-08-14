/**
 * Layout geometry constants shared between server and browser.
 *
 * IMPORTANT: This file and server/layouts.js must stay numerically
 * identical. This one is an ES module (used by browser pages), the other
 * is CommonJS (used by server/*.js). If you change a number here, change
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

// grid2c: Taste of Korea 2026 blue 2x2 frame. Keep in sync with
// server/layouts.js.
const CARD_C_SLOTS = [
  { x: 67, y: 169, w: 387, h: 542 },
  { x: 569, y: 169, w: 389, h: 542 },
  { x: 67, y: 758, w: 387, h: 550 },
  { x: 569, y: 758, w: 389, h: 550 },
];

// grid2d: holographic Taste of Korea 2026 2x2 frame (2026-08-13). Native
// artwork size (1240x1748) instead of CARD_CANVAS_WIDTH/HEIGHT — a hair off
// exact 2:3, so the print sheet stretches it ~6% vertically (fine for a
// decorative frame; a future redesign should target exact 2:3, e.g.
// 1200x1800). Slots measured from the artwork's own alpha channel. Keep in
// sync with server/layouts.js.
const CARD_D_CANVAS_WIDTH = 1240;
const CARD_D_CANVAS_HEIGHT = 1748;
const CARD_D_SLOTS = [
  { x: 125, y: 407, w: 429, h: 369 },
  { x: 672, y: 395, w: 447, h: 390 },
  { x: 129, y: 966, w: 430, h: 364 },
  { x: 683, y: 961, w: 421, h: 359 },
];

// grid2e~grid2k (2026-08-14) — 5 new frame designs (pink hanbok, blue crane,
// bear+tiger, and 2 side-by-side pairs split into 4: 777/goodluck, kpop,
// minecraft, korean-traditional). Each uses its own native canvas size —
// slots measured directly from each artwork's own alpha channel (real
// transparent cutouts). Keep in sync with server/layouts.js.
const CARD_E_CANVAS_WIDTH = 1414;
const CARD_E_CANVAS_HEIGHT = 2000;
const CARD_E_SLOTS = [
  { x: 106, y: 384, w: 549, h: 567 },
  { x: 746, y: 385, w: 539, h: 566 },
  { x: 107, y: 1029, w: 562, h: 506 },
  { x: 746, y: 1029, w: 539, h: 506 },
];

const CARD_F_CANVAS_WIDTH = 1414;
const CARD_F_CANVAS_HEIGHT = 2000;
const CARD_F_SLOTS = [
  { x: 89, y: 463, w: 595, h: 577 },
  { x: 735, y: 476, w: 589, h: 547 },
  { x: 89, y: 1091, w: 595, h: 569 },
  { x: 735, y: 1091, w: 589, h: 569 },
];

const CARD_G_CANVAS_WIDTH = 1414;
const CARD_G_CANVAS_HEIGHT = 2000;
const CARD_G_SLOTS = [
  { x: 159, y: 662, w: 469, h: 463 },
  { x: 752, y: 662, w: 460, h: 478 },
  { x: 160, y: 1263, w: 471, h: 466 },
  { x: 757, y: 1263, w: 462, h: 466 },
];

const CARD_H_CANVAS_WIDTH = 874;
const CARD_H_CANVAS_HEIGHT = 1240;
const CARD_H_SLOTS = [
  { x: 30, y: 250, w: 397, h: 385 },
  { x: 451, y: 250, w: 397, h: 385 },
  { x: 30, y: 659, w: 397, h: 394 },
  { x: 451, y: 658, w: 397, h: 395 },
];

const CARD_I_CANVAS_WIDTH = 874;
const CARD_I_CANVAS_HEIGHT = 1240;
const CARD_I_SLOTS = [
  { x: 28, y: 238, w: 397, h: 397 },
  { x: 449, y: 238, w: 397, h: 397 },
  { x: 28, y: 658, w: 397, h: 395 },
  { x: 449, y: 658, w: 397, h: 395 },
];

const CARD_J_CANVAS_WIDTH = 874;
const CARD_J_CANVAS_HEIGHT = 1240;
const CARD_J_SLOTS = [
  { x: 28, y: 226, w: 397, h: 398 },
  { x: 449, y: 226, w: 397, h: 398 },
  { x: 28, y: 647, w: 397, h: 397 },
  { x: 449, y: 647, w: 397, h: 397 },
];

const CARD_K_CANVAS_WIDTH = 874;
const CARD_K_CANVAS_HEIGHT = 1240;
const CARD_K_SLOTS = [
  { x: 28, y: 226, w: 397, h: 398 },
  { x: 449, y: 226, w: 397, h: 398 },
  { x: 28, y: 647, w: 397, h: 397 },
  { x: 449, y: 647, w: 397, h: 397 },
];

export const LAYOUTS = {
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
  grid2e: {
    canvasWidth: CARD_E_CANVAS_WIDTH,
    canvasHeight: CARD_E_CANVAS_HEIGHT,
    slots: CARD_E_SLOTS,
  },
  grid2f: {
    canvasWidth: CARD_F_CANVAS_WIDTH,
    canvasHeight: CARD_F_CANVAS_HEIGHT,
    slots: CARD_F_SLOTS,
  },
  grid2g: {
    canvasWidth: CARD_G_CANVAS_WIDTH,
    canvasHeight: CARD_G_CANVAS_HEIGHT,
    slots: CARD_G_SLOTS,
  },
  grid2h: {
    canvasWidth: CARD_H_CANVAS_WIDTH,
    canvasHeight: CARD_H_CANVAS_HEIGHT,
    slots: CARD_H_SLOTS,
  },
  grid2i: {
    canvasWidth: CARD_I_CANVAS_WIDTH,
    canvasHeight: CARD_I_CANVAS_HEIGHT,
    slots: CARD_I_SLOTS,
  },
  grid2j: {
    canvasWidth: CARD_J_CANVAS_WIDTH,
    canvasHeight: CARD_J_CANVAS_HEIGHT,
    slots: CARD_J_SLOTS,
  },
  grid2k: {
    canvasWidth: CARD_K_CANVAS_WIDTH,
    canvasHeight: CARD_K_CANVAS_HEIGHT,
    slots: CARD_K_SLOTS,
  },
};

export function getLayout(layoutName) {
  const layout = LAYOUTS[layoutName];
  if (!layout) {
    throw new Error(`Unknown layout: ${layoutName}`);
  }
  return layout;
}
