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

// grid2e/grid2f (2026-08-13): the "Taste of Korea" and "PLAY" 2x2 frames,
// which arrived as a single side-by-side artwork and were split at x=875 (the
// column where the beige background gives way to the PLAY frame's grey).
// Slots were measured from each frame's own alpha channel — see grid2d's note
// on why every frame gets its own entry rather than sharing one coordinate
// system.
//
// Both canvases are ~1.42 tall-to-wide where a 4x6 print sheet is 1.5, so the
// sheet stretches them ~6% vertically, exactly as grid2d already does. Fine
// for decorative artwork; a redesign at 1200x1800 would remove it.
const CARD_E_CANVAS_WIDTH = 875;
const CARD_E_CANVAS_HEIGHT = 1240;
const CARD_E_SLOTS = [
  { x: 28, y: 241, w: 398, h: 397 },
  { x: 449, y: 241, w: 398, h: 397 },
  // The bear/tiger sticker sits on top of this window's lower edge, so the
  // measured transparent run stops early (h=303). The real window matches its
  // neighbour — using the measured value would letterbox this one photo.
  { x: 28, y: 662, w: 398, h: 391 },
  { x: 449, y: 662, w: 398, h: 391 },
];

const CARD_F_CANVAS_WIDTH = 873;
const CARD_F_CANVAS_HEIGHT = 1240;
const CARD_F_SLOTS = [
  { x: 27, y: 28, w: 398, h: 398 },
  { x: 448, y: 28, w: 398, h: 398 },
  { x: 27, y: 449, w: 398, h: 398 },
  { x: 448, y: 449, w: 398, h: 398 },
];

// grid2g..grid2m (2026-08-14) — seven more 2x2 frames for TOK2026, from five
// artworks: three standalone 1414x2000 designs, plus two 1748x1240 sheets that
// again carried two frames side by side and were cut at x=874 (exactly half),
// the same way grid2e/grid2f were.
//
// Two things differ from how the earlier entries were derived, and both matter
// if these numbers are ever re-measured:
//
//  1. Each slot is the measured transparent window grown by 3px on every side.
//     composeFrame paints a black canvas first and clips each photo to its slot,
//     so a slot that stops exactly at the cutout leaves the window's
//     anti-aliased edge composited over black — a dark hairline around all four
//     photos on the print. The extra 3px tucks the photo under the frame's own
//     opaque border instead, where it cannot be seen.
//  2. The source PNGs were flattened before being installed: every transparent
//     pixel OUTSIDE the four windows was inpainted from its neighbours and made
//     opaque. As delivered they had a transparent band along one outer edge and
//     a thin transparent ring around each window (sitting outside the drawn
//     border line), all of which would likewise have printed black. Re-cutting
//     any of these from the original artwork means redoing that step.
//
// Canvas ratios are 1.414 (1414x2000) and 1.419 (874x1240) against the print
// sheet's 1.5, so composePrintSheet stretches them ~6% vertically — the same
// tradeoff grid2d/grid2e/grid2f already make, and fine for decorative artwork.
const CARD_GHI_CANVAS_WIDTH = 1414;
const CARD_GHI_CANVAS_HEIGHT = 2000;

// grid2g: pink cherry-blossom hanbok. Its lower row of windows is genuinely
// shorter than its upper row (487 vs 544) — that is the design, not a mis-read.
const CARD_G_SLOTS = [
  { x: 119, y: 396, w: 540, h: 544 },
  { x: 758, y: 396, w: 530, h: 544 },
  { x: 120, y: 1040, w: 540, h: 487 },
  // The rabbit sticker covers this window's lower edge, so its transparent run
  // measures 27px short. Squared up to match the window beside it.
  { x: 758, y: 1040, w: 530, h: 487 },
];

// grid2h: navy/gold crane. The tassel overlaps the top-right window's right
// edge, so that one is squared up against the window below it too.
const CARD_H_SLOTS = [
  { x: 101, y: 473, w: 568, h: 554 },
  { x: 746, y: 473, w: 569, h: 554 },
  { x: 101, y: 1103, w: 567, h: 549 },
  { x: 746, y: 1103, w: 569, h: 549 },
];

// grid2i: bear + tiger mascots.
const CARD_I_SLOTS = [
  { x: 156, y: 659, w: 475, h: 470 },
  { x: 749, y: 659, w: 467, h: 485 },
  { x: 157, y: 1260, w: 478, h: 473 },
  { x: 754, y: 1260, w: 469, h: 473 },
];

const CARD_JKLM_CANVAS_WIDTH = 874;
const CARD_JKLM_CANVAS_HEIGHT = 1240;

// grid2j/grid2k: the green "GOOD LUCK" and blue "KPOP" halves of one sheet.
// Note grid2j is a separate design from the existing grid2b, which is also
// named GOOD LUCK; they share nothing but the words.
const CARD_J_SLOTS = [
  { x: 27, y: 247, w: 404, h: 392 },
  { x: 448, y: 247, w: 404, h: 392 },
  { x: 27, y: 655, w: 404, h: 402 },
  { x: 448, y: 655, w: 404, h: 402 },
];

const CARD_K_SLOTS = [
  { x: 25, y: 235, w: 404, h: 404 },
  { x: 446, y: 235, w: 404, h: 404 },
  { x: 25, y: 655, w: 404, h: 402 },
  { x: 446, y: 655, w: 404, h: 402 },
];

// grid2l/grid2m: the pixel-art green and the black/gold halves of the other
// sheet. These two really were drawn on one shared grid, so their numbers are
// identical — kept as separate entries anyway so that re-cutting one artwork
// can never silently move the other's photos.
const CARD_L_SLOTS = [
  { x: 25, y: 223, w: 404, h: 405 },
  { x: 446, y: 223, w: 404, h: 405 },
  { x: 25, y: 644, w: 404, h: 404 },
  { x: 446, y: 644, w: 404, h: 404 },
];

const CARD_M_SLOTS = [
  { x: 25, y: 223, w: 404, h: 405 },
  { x: 446, y: 223, w: 404, h: 405 },
  { x: 25, y: 644, w: 404, h: 404 },
  { x: 446, y: 644, w: 404, h: 404 },
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
    canvasWidth: CARD_GHI_CANVAS_WIDTH,
    canvasHeight: CARD_GHI_CANVAS_HEIGHT,
    slots: CARD_G_SLOTS,
  },
  grid2h: {
    canvasWidth: CARD_GHI_CANVAS_WIDTH,
    canvasHeight: CARD_GHI_CANVAS_HEIGHT,
    slots: CARD_H_SLOTS,
  },
  grid2i: {
    canvasWidth: CARD_GHI_CANVAS_WIDTH,
    canvasHeight: CARD_GHI_CANVAS_HEIGHT,
    slots: CARD_I_SLOTS,
  },
  grid2j: {
    canvasWidth: CARD_JKLM_CANVAS_WIDTH,
    canvasHeight: CARD_JKLM_CANVAS_HEIGHT,
    slots: CARD_J_SLOTS,
  },
  grid2k: {
    canvasWidth: CARD_JKLM_CANVAS_WIDTH,
    canvasHeight: CARD_JKLM_CANVAS_HEIGHT,
    slots: CARD_K_SLOTS,
  },
  grid2l: {
    canvasWidth: CARD_JKLM_CANVAS_WIDTH,
    canvasHeight: CARD_JKLM_CANVAS_HEIGHT,
    slots: CARD_L_SLOTS,
  },
  grid2m: {
    canvasWidth: CARD_JKLM_CANVAS_WIDTH,
    canvasHeight: CARD_JKLM_CANVAS_HEIGHT,
    slots: CARD_M_SLOTS,
  },
};

export function getLayout(layoutName) {
  const layout = LAYOUTS[layoutName];
  if (!layout) {
    throw new Error(`Unknown layout: ${layoutName}`);
  }
  return layout;
}
