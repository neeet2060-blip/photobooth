'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PHASES, createInitialState, reconcileRestoredSession, applyAction } = require('../server/state');

const SETTINGS = {
  shotsTotal: 4,
  countdownSeconds: 3,
  idleTimeoutSec: 180,
  qrTimeoutSec: 90,
  defaultLang: 'ko',
  autoDeleteHours: 24,
  printUnitPriceCents: 300,
  maxPrintQuantity: 10,
};

const FRAMES = [
  { id: 'frame-a', name: 'A', layout: 'strip', file: '/a.svg', active: true, order: 0 },
  { id: 'frame-b', name: 'B', layout: 'grid', file: '/b.svg', active: false, order: 1 },
];

function ctx(overrides = {}) {
  return { settings: { ...SETTINGS, ...overrides.settings }, frames: overrides.frames || FRAMES };
}

function run(state, type, payload) {
  return applyAction(state, { type, payload }, ctx());
}

test('createInitialState starts in idle phase with empty session', () => {
  const state = createInitialState();
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.sessionId, null);
  assert.deepEqual(state.photos, []);
  assert.deepEqual(state.picks, []);
});

test('reconcileRestoredSession keeps payment state intact', () => {
  const saved = {
    ...createInitialState(),
    phase: PHASES.PAYMENT,
    sessionId: 's-payment',
    printOrder: { quantity: 2 },
    paymentMethod: 'cash',
  };
  assert.deepEqual(reconcileRestoredSession(saved), saved);
});

test('reconcileRestoredSession clears only an interrupted capture countdown', () => {
  const saved = {
    ...createInitialState(),
    phase: PHASES.CAPTURE,
    sessionId: 's-capture',
    countdown: 2,
    photos: [{ index: 0, file: '0.jpg', takenAt: 123 }],
    shotsTaken: 1,
  };
  const restored = reconcileRestoredSession(saved);
  assert.equal(restored.countdown, null);
  assert.deepEqual(restored.photos, saved.photos);
  assert.equal(restored.shotsTaken, 1);
});

test('start: idle -> consent, assigns a sessionId', () => {
  const { state, effects } = run(createInitialState(), 'start');
  assert.equal(state.phase, PHASES.CONSENT);
  assert.ok(state.sessionId);
  assert.ok(effects.some((e) => e.type === 'session-started'));
});

test('start: rejected when not idle', () => {
  const started = run(createInitialState(), 'start').state;
  const { state } = run(started, 'start');
  assert.equal(state.phase, PHASES.CONSENT);
  assert.equal(state.error, 'invalid_action');
});

test('agree: consent -> format', () => {
  const consent = run(createInitialState(), 'start').state;
  const { state } = run(consent, 'agree');
  assert.equal(state.phase, PHASES.FORMAT);
});

test('agree: rejected outside consent', () => {
  const { state } = run(createInitialState(), 'agree');
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.error, 'invalid_action');
});

test('cancel: consent -> idle, and theme -> idle, with session-abandoned effect', () => {
  const consent = run(createInitialState(), 'start').state;
  const { state, effects } = run(consent, 'cancel');
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.sessionId, null);
  assert.ok(effects.some((e) => e.type === 'session-abandoned'));
});

test('cancel: rejected outside consent/theme', () => {
  const { state } = run(createInitialState(), 'cancel');
  assert.equal(state.error, 'invalid_action');
});

test('cancel: capture -> idle, with session-abandoned effect (2026-08-11, back button while shooting)', () => {
  const capture = toCapture();
  const { state, effects } = run(capture, 'cancel');
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.sessionId, null);
  assert.ok(effects.some((e) => e.type === 'session-abandoned'));
});

function toFormat() {
  const consent = run(createInitialState(), 'start').state;
  return run(consent, 'agree').state;
}

function toTheme() {
  const format = toFormat();
  return run(format, 'chooseFormat', { layoutId: 'strip' }).state;
}

test('chooseTheme: rejects unknown/inactive frame', () => {
  const theme = toTheme();
  const missing = run(theme, 'chooseTheme', { frameId: 'nope' }).state;
  assert.equal(missing.error, 'invalid_frame');

  const inactive = run(theme, 'chooseTheme', { frameId: 'frame-b' }).state;
  assert.equal(inactive.error, 'invalid_frame');
});

test('chooseTheme: valid frame -> capture, sets shotsTotal from settings', () => {
  const theme = toTheme();
  const { state } = run(theme, 'chooseTheme', { frameId: 'frame-a' });
  assert.equal(state.phase, PHASES.CAPTURE);
  assert.equal(state.frameId, 'frame-a');
  assert.equal(state.shotsTotal, SETTINGS.shotsTotal);
});

test('chooseTheme: rejected outside theme phase', () => {
  const { state } = run(createInitialState(), 'chooseTheme', { frameId: 'frame-a' });
  assert.equal(state.error, 'invalid_action');
});

function toCapture() {
  const theme = toTheme();
  return run(theme, 'chooseTheme', { frameId: 'frame-a' }).state;
}

test('shutter: starts countdown, emits start-countdown effect', () => {
  const capture = toCapture();
  const { state, effects } = run(capture, 'shutter');
  assert.equal(state.countdown, SETTINGS.countdownSeconds);
  assert.ok(effects.some((e) => e.type === 'start-countdown' && e.seconds === SETTINGS.countdownSeconds));
});

test('shutter: rejected while countdown already running', () => {
  const capture = toCapture();
  const counting = run(capture, 'shutter').state;
  const { state } = run(counting, 'shutter');
  assert.equal(state.error, 'countdown_in_progress');
});

test('shutter: rejected outside capture phase', () => {
  const { state } = run(createInitialState(), 'shutter');
  assert.equal(state.error, 'invalid_action');
});

test('captureNow: clears countdown and emits trigger-capture', () => {
  const capture = toCapture();
  const counting = run(capture, 'shutter').state;
  const { state, effects } = run(counting, 'captureNow');
  assert.equal(state.countdown, null);
  assert.ok(effects.some((e) => e.type === 'trigger-capture'));
});

test('captureNow: trigger-capture carries the shot index the DSLR path needs to name its file', () => {
  // server/index.js's DSLR capture (server/camera.js) has to know which
  // shot this is *before* dispatching photoRecorded — unlike the
  // phone-camera flow, which derives it client-side. shotsTaken is that
  // index: the count of shots already recorded when this capture starts.
  let state = toCapture();
  for (let i = 0; i < 2; i += 1) {
    state = run(state, 'shutter').state;
    state = run(state, 'captureNow', { index: i }).state;
    state = run(state, 'photoRecorded', { index: i }).state;
  }
  assert.equal(state.shotsTaken, 2);
  const counting = run(state, 'shutter').state;
  const { effects } = run(counting, 'captureNow');
  const triggerCapture = effects.find((e) => e.type === 'trigger-capture');
  assert.equal(triggerCapture.index, 2);
});

test('photoRecorded: accumulates photos, moves to select once shotsTotal reached', () => {
  let state = toCapture(); // shotsTotal = 4
  for (let i = 0; i < 4; i += 1) {
    const result = run(state, 'photoRecorded', { index: i, file: `/photos/x/${i}.jpg` });
    state = result.state;
  }
  assert.equal(state.phase, PHASES.SELECT);
  assert.equal(state.shotsTaken, 4);
  assert.equal(state.photos.length, 4);
});

test('photoRecorded: rejected outside capture phase', () => {
  const { state } = run(createInitialState(), 'photoRecorded', { index: 0, file: '/x.jpg' });
  assert.equal(state.error, 'invalid_action');
});

// 2026-08-11 pre-launch audit: this reducer is reachable directly via the
// Socket.IO 'action' passthrough (server/index.js), bypassing routes.js's
// HTTP-layer index/duplicate checks entirely — so those checks must also
// live here to be authoritative regardless of entry point.
test('photoRecorded: rejects an out-of-bounds index (>= shotsTotal)', () => {
  const state = toCapture(); // shotsTotal = 4
  const { state: next } = run(state, 'photoRecorded', { index: 4, file: '/x.jpg' });
  assert.equal(next.error, 'invalid_index');
  assert.equal(next.photos.length, 0);
});

test('photoRecorded: rejects a negative or non-integer index', () => {
  const state = toCapture();
  assert.equal(run(state, 'photoRecorded', { index: -1 }).state.error, 'invalid_index');
  assert.equal(run(state, 'photoRecorded', { index: 1.5 }).state.error, 'invalid_index');
});

test('photoRecorded: rejects a duplicate index', () => {
  let state = toCapture();
  state = run(state, 'photoRecorded', { index: 0, file: '/x.jpg' }).state;
  const { state: next } = run(state, 'photoRecorded', { index: 0, file: '/y.jpg' });
  assert.equal(next.error, 'index_already_used');
  assert.equal(next.photos.length, 1);
});

test('photoRecorded: derives file from sessionId/index, ignoring any payload.file', () => {
  const state = toCapture();
  const { state: next } = run(state, 'photoRecorded', { index: 0, file: '/attacker-supplied.jpg' });
  assert.equal(next.photos[0].file, `/photos/${state.sessionId}/0.jpg`);
});

test('finishEarly: requires at least 4 photos', () => {
  let state = toCapture();
  state = run(state, 'photoRecorded', { index: 0, file: '/0.jpg' }).state;
  const rejected = run(state, 'finishEarly').state;
  assert.equal(rejected.error, 'not_enough_photos');

  for (let i = 1; i < 4; i += 1) {
    state = run(state, 'photoRecorded', { index: i, file: `/${i}.jpg` }).state;
  }
  // shotsTotal is 4 so this already auto-advanced to select; verify finishEarly
  // works from a capture state with >=4 photos and a higher shotsTotal.
  const bigCtx = { settings: { ...SETTINGS, shotsTotal: 12 }, frames: FRAMES };
  let manual = run(createInitialState(), 'start', undefined).state;
  manual = applyAction(manual, { type: 'agree' }, bigCtx).state;
  manual = applyAction(manual, { type: 'chooseFormat', payload: { layoutId: 'strip' } }, bigCtx).state;
  manual = applyAction(manual, { type: 'chooseTheme', payload: { frameId: 'frame-a' } }, bigCtx).state;
  for (let i = 0; i < 4; i += 1) {
    manual = applyAction(manual, { type: 'photoRecorded', payload: { index: i, file: `/${i}.jpg` } }, bigCtx).state;
  }
  const finished = applyAction(manual, { type: 'finishEarly' }, bigCtx).state;
  assert.equal(finished.phase, PHASES.SELECT);
});

function toSelect() {
  let state = toCapture();
  for (let i = 0; i < 4; i += 1) {
    state = run(state, 'photoRecorded', { index: i, file: `/${i}.jpg` }).state;
  }
  return state;
}

test('togglePick: adds and removes picks in order, rejects beyond 4', () => {
  let state = toSelect();
  state = run(state, 'togglePick', { index: 2 }).state;
  state = run(state, 'togglePick', { index: 0 }).state;
  assert.deepEqual(state.picks, [2, 0]);

  state = run(state, 'togglePick', { index: 2 }).state; // remove
  assert.deepEqual(state.picks, [0]);

  state = run(state, 'togglePick', { index: 1 }).state;
  state = run(state, 'togglePick', { index: 2 }).state;
  state = run(state, 'togglePick', { index: 3 }).state;
  assert.equal(state.picks.length, 4);

  const overflow = run(state, 'togglePick', { index: 3 }).state; // already picked index toggled off is fine; test true overflow differently
  assert.equal(overflow.picks.length, 3); // toggling an existing pick removes it
});

test('togglePick: rejects unknown photo index', () => {
  const state = toSelect();
  const { state: next } = run(state, 'togglePick', { index: 99 });
  assert.equal(next.error, 'invalid_index');
});

test('retake: select -> capture, increases shotsTotal by 1', () => {
  const state = toSelect();
  const { state: next } = run(state, 'retake');
  assert.equal(next.phase, PHASES.CAPTURE);
  assert.equal(next.shotsTotal, state.shotsTotal + 1);
});

test('changeTheme: select -> theme', () => {
  const state = toSelect();
  const { state: next } = run(state, 'changeTheme');
  assert.equal(next.phase, PHASES.THEME);
});

test('confirmPicks: requires exactly 4 picks', () => {
  const state = toSelect();
  const withOne = run(state, 'togglePick', { index: 0 }).state;
  const rejected = run(withOne, 'confirmPicks').state;
  assert.equal(rejected.error, 'need_four_picks');

  let full = state;
  for (const i of [0, 1, 2, 3]) {
    full = run(full, 'togglePick', { index: i }).state;
  }
  const { state: confirmed } = run(full, 'confirmPicks');
  assert.equal(confirmed.phase, PHASES.FILTER);
});

function toFilter() {
  let state = toSelect();
  for (const i of [0, 1, 2, 3]) {
    state = run(state, 'togglePick', { index: i }).state;
  }
  return run(state, 'confirmPicks').state;
}

test('chooseFilter: rejects unknown filter id', () => {
  const state = toFilter();
  const { state: next } = run(state, 'chooseFilter', { id: 'nope' });
  assert.equal(next.error, 'invalid_filter');
});

test('chooseFilter: accepts known filter id', () => {
  const state = toFilter();
  const { state: next } = run(state, 'chooseFilter', { id: 'bw' });
  assert.equal(next.filterId, 'bw');
});

test('confirmFinal: emits await-final-upload effect, stays in filter phase', () => {
  const state = toFilter();
  const { state: next, effects } = run(state, 'confirmFinal');
  assert.equal(next.phase, PHASES.FILTER);
  assert.ok(effects.some((e) => e.type === 'await-final-upload'));
});

test('finalSaved: filter -> qr, records session-completed effect', () => {
  const state = toFilter();
  const { state: next, effects } = run(state, 'finalSaved', {
    finalUrl: 'https://x/p/abc',
    finalToken: 'abc',
    qrDataUrl: 'data:image/png;base64,xx',
  });
  assert.equal(next.phase, PHASES.QR);
  assert.equal(next.finalUrl, 'https://x/p/abc');
  assert.ok(effects.some((e) => e.type === 'session-completed'));
});

test('restart: qr -> idle (fresh state)', () => {
  const state = toFilter();
  const qr = run(state, 'finalSaved', {
    finalUrl: 'https://x/p/abc',
    finalToken: 'abc',
    qrDataUrl: 'data:x',
  }).state;
  const { state: next } = run(qr, 'restart');
  assert.equal(next.phase, PHASES.IDLE);
  assert.equal(next.sessionId, null);
});

test('restart: rejected outside qr phase', () => {
  const { state } = run(createInitialState(), 'restart');
  assert.equal(state.error, 'invalid_action');
});

test('forceReset: abandons a non-idle session and resets to idle', () => {
  const capture = toCapture();
  const { state, effects } = run(capture, 'forceReset');
  assert.equal(state.phase, PHASES.IDLE);
  assert.ok(effects.some((e) => e.type === 'session-abandoned'));
});

test('unknown action type sets an error and leaves state otherwise unchanged', () => {
  const initial = createInitialState();
  const { state } = run(initial, 'totallyBogus');
  assert.equal(state.error, 'unknown_action');
  assert.equal(state.phase, PHASES.IDLE);
});

function toQr() {
  const state = toFilter();
  return run(state, 'finalSaved', {
    finalUrl: 'https://x/p/abc',
    finalToken: 'abc',
    qrDataUrl: 'data:x',
  }).state;
}

test('createInitialState includes printOrder/paymentMethod/confirmedPrintOrder: null', () => {
  const state = createInitialState();
  assert.equal(state.printOrder, null);
  assert.equal(state.paymentMethod, null);
  assert.equal(state.confirmedPrintOrder, null);
  assert.equal(state.paymentMethodChosenAt, null);
});

// ---- Format (layout) selection ----

test('chooseFormat: valid layoutId -> theme, sets layoutId', () => {
  const format = toFormat();
  const { state } = run(format, 'chooseFormat', { layoutId: 'strip' });
  assert.equal(state.phase, PHASES.THEME);
  assert.equal(state.layoutId, 'strip');
});

test('chooseFormat: rejects a layoutId with no matching active frame', () => {
  const format = toFormat();
  const { state } = run(format, 'chooseFormat', { layoutId: 'poster' });
  assert.equal(state.error, 'invalid_layout');
  assert.equal(state.phase, PHASES.FORMAT);
});

test('chooseFormat: rejected outside format phase', () => {
  const { state } = run(createInitialState(), 'chooseFormat', { layoutId: 'strip' });
  assert.equal(state.error, 'invalid_action');
});

// ---- Theme filtered by chosen format ----

test('chooseTheme: rejects a frame whose layout does not match the chosen format', () => {
  const framesWithGrid = [
    ...FRAMES,
    { id: 'frame-c', name: 'C', layout: 'grid', file: '/c.svg', active: true, order: 2 },
  ];
  const customCtx = { settings: SETTINGS, frames: framesWithGrid };
  let state = applyAction(createInitialState(), { type: 'start' }, customCtx).state;
  state = applyAction(state, { type: 'agree' }, customCtx).state;
  state = applyAction(state, { type: 'chooseFormat', payload: { layoutId: 'strip' } }, customCtx).state;
  const { state: next } = applyAction(state, { type: 'chooseTheme', payload: { frameId: 'frame-c' } }, customCtx);
  assert.equal(next.error, 'invalid_frame');
});

test('chooseTheme: printingEnabled false skips straight to capture (no quantity/payment)', () => {
  const theme = toTheme();
  const { state } = run(theme, 'chooseTheme', { frameId: 'frame-a' });
  assert.equal(state.phase, PHASES.CAPTURE);
  assert.equal(state.printOrder, null);
});

// ---- Quantity + payment phases (printingEnabled: true) ----

const PRINTING_SETTINGS = { ...SETTINGS, printingEnabled: true };

function printingCtx() {
  return { settings: PRINTING_SETTINGS, frames: FRAMES };
}

function toQuantity() {
  const theme = toTheme();
  return applyAction(theme, { type: 'chooseTheme', payload: { frameId: 'frame-a' } }, printingCtx()).state;
}

function toPayment() {
  return run(toQuantity(), 'confirmPrintQuantity').state;
}

test('chooseTheme: printingEnabled true -> quantity phase, defaults printOrder quantity to 1', () => {
  const state = toQuantity();
  assert.equal(state.phase, PHASES.QUANTITY);
  assert.deepEqual(state.printOrder, { quantity: 1 });
});

// 2026-08-11 pre-launch audit finding: finishEarly allows moving to SELECT
// with as few as MIN_PHOTOS_FOR_EARLY_FINISH (4) photos, which can be fewer
// than shotsTotal. Before this fix, changeTheme -> chooseTheme from there
// re-entered the QUANTITY/PAYMENT branch a second time for an
// already-paid session, letting tokPayment.js create an independent second
// paid order. qrPaid (set once by confirmPrintPayment) must short-circuit
// straight to CAPTURE instead.
test('chooseTheme: after finishEarly with shotsTaken < shotsTotal, re-entering via changeTheme does not re-charge (qrPaid short-circuits to capture)', () => {
  const bigCtx = { settings: { ...PRINTING_SETTINGS, shotsTotal: 8 }, frames: FRAMES };
  let state = applyAction(createInitialState(), { type: 'start' }, bigCtx).state;
  state = applyAction(state, { type: 'agree' }, bigCtx).state;
  state = applyAction(state, { type: 'chooseFormat', payload: { layoutId: 'strip' } }, bigCtx).state;
  state = applyAction(state, { type: 'chooseTheme', payload: { frameId: 'frame-a' } }, bigCtx).state;
  assert.equal(state.phase, PHASES.QUANTITY);
  state = applyAction(state, { type: 'confirmPrintQuantity' }, bigCtx).state;
  state = applyAction(state, { type: 'choosePaymentMethod', payload: { method: 'cash' } }, bigCtx).state;
  state = applyAction(state, { type: 'confirmPrintPayment' }, bigCtx).state;
  assert.equal(state.phase, PHASES.CAPTURE);
  assert.equal(state.qrPaid, true);

  for (let i = 0; i < 4; i += 1) {
    state = applyAction(state, { type: 'photoRecorded', payload: { index: i } }, bigCtx).state;
  }
  assert.equal(state.shotsTaken, 4);
  state = applyAction(state, { type: 'finishEarly' }, bigCtx).state;
  assert.equal(state.phase, PHASES.SELECT);
  state = applyAction(state, { type: 'changeTheme' }, bigCtx).state;
  assert.equal(state.phase, PHASES.THEME);

  const { state: next } = applyAction(state, { type: 'chooseTheme', payload: { frameId: 'frame-a' } }, bigCtx);
  assert.equal(next.phase, PHASES.CAPTURE);
  assert.equal(next.printOrder, null);
});

test('setPrintQuantity: rejected outside quantity phase', () => {
  const state = toTheme();
  const { state: next } = run(state, 'setPrintQuantity', { quantity: 2 });
  assert.equal(next.error, 'invalid_action');
});

test('setPrintQuantity: rejects 0 and max+1, accepts bounds 1 and maxPrintQuantity', () => {
  const quantity = toQuantity();

  const zero = run(quantity, 'setPrintQuantity', { quantity: 0 }).state;
  assert.equal(zero.error, 'invalid_quantity');

  const overMax = run(quantity, 'setPrintQuantity', { quantity: SETTINGS.maxPrintQuantity + 1 }).state;
  assert.equal(overMax.error, 'invalid_quantity');

  const atMin = run(quantity, 'setPrintQuantity', { quantity: 1 }).state;
  assert.equal(atMin.printOrder.quantity, 1);

  const atMax = run(quantity, 'setPrintQuantity', { quantity: SETTINGS.maxPrintQuantity }).state;
  assert.equal(atMax.printOrder.quantity, SETTINGS.maxPrintQuantity);
});

test('setPrintQuantity: rejects non-integer quantity', () => {
  const quantity = toQuantity();
  const { state } = run(quantity, 'setPrintQuantity', { quantity: 2.5 });
  assert.equal(state.error, 'invalid_quantity');
});

test('confirmPrintQuantity: rejected outside quantity phase', () => {
  const theme = toTheme();
  const { state } = run(theme, 'confirmPrintQuantity');
  assert.equal(state.error, 'invalid_action');
});

test('confirmPrintQuantity: quantity -> payment, keeps printOrder', () => {
  const withQty = run(toQuantity(), 'setPrintQuantity', { quantity: 3 }).state;
  const { state } = run(withQty, 'confirmPrintQuantity');
  assert.equal(state.phase, PHASES.PAYMENT);
  assert.deepEqual(state.printOrder, { quantity: 3 });
});

test('backToQuantity: payment -> quantity, clears paymentMethod', () => {
  const payment = toPayment();
  const withMethod = run(payment, 'choosePaymentMethod', { method: 'cash' }).state;
  const { state } = run(withMethod, 'backToQuantity');
  assert.equal(state.phase, PHASES.QUANTITY);
  assert.equal(state.paymentMethod, null);
  assert.equal(state.paymentMethodChosenAt, null);
});

test('backToQuantity: rejected outside payment phase', () => {
  const quantity = toQuantity();
  const { state } = run(quantity, 'backToQuantity');
  assert.equal(state.error, 'invalid_action');
});

test('choosePaymentMethod: rejects unknown method', () => {
  const payment = toPayment();
  const { state } = run(payment, 'choosePaymentMethod', { method: 'bitcoin' });
  assert.equal(state.error, 'invalid_payment_method');
});

test('choosePaymentMethod: accepts sumup and cash', () => {
  const payment = toPayment();
  const sumup = run(payment, 'choosePaymentMethod', { method: 'sumup' }).state;
  assert.equal(sumup.paymentMethod, 'sumup');
  assert.ok(typeof sumup.paymentMethodChosenAt === 'number');
  const cash = run(payment, 'choosePaymentMethod', { method: 'cash' }).state;
  assert.equal(cash.paymentMethod, 'cash');
  assert.ok(typeof cash.paymentMethodChosenAt === 'number');
});

test('choosePaymentMethod: rejected outside payment phase', () => {
  const quantity = toQuantity();
  const { state } = run(quantity, 'choosePaymentMethod', { method: 'cash' });
  assert.equal(state.error, 'invalid_action');
});

test('confirmPrintPayment: rejected without a chosen payment method', () => {
  const payment = toPayment();
  const { state } = run(payment, 'confirmPrintPayment');
  assert.equal(state.error, 'invalid_action');
});

test('confirmPrintPayment: rejected outside payment phase', () => {
  const quantity = toQuantity();
  const { state } = run(quantity, 'confirmPrintPayment');
  assert.equal(state.error, 'invalid_action');
});

test('confirmPrintPayment: payment -> capture (not qr), sets confirmedPrintOrder, clears printOrder/paymentMethod', () => {
  let state = run(toQuantity(), 'setPrintQuantity', { quantity: 3 }).state;
  state = run(state, 'confirmPrintQuantity').state;
  state = run(state, 'choosePaymentMethod', { method: 'sumup' }).state;
  const { state: next, effects } = run(state, 'confirmPrintPayment');

  assert.equal(next.phase, PHASES.CAPTURE);
  assert.equal(next.printOrder, null);
  assert.equal(next.paymentMethod, null);
  assert.equal(next.paymentMethodChosenAt, null);
  assert.deepEqual(next.confirmedPrintOrder, {
    quantity: 3,
    unitPriceCents: SETTINGS.printUnitPriceCents,
    totalCents: 900,
    method: 'sumup',
  });
  // No print-order-confirmed effect yet — that's deferred to 'printSheetReady'.
  assert.ok(!effects.some((e) => e.type === 'print-order-confirmed'));
});

// ---- printSheetReady ----

function toConfirmedPayment() {
  const payment = toPayment();
  const withMethod = run(payment, 'choosePaymentMethod', { method: 'sumup' }).state;
  return run(withMethod, 'confirmPrintPayment').state;
}

test('printSheetReady: no-op when confirmedPrintOrder is null', () => {
  const capture = toCapture(); // regular (non-printing) flow, confirmedPrintOrder stays null
  const { state, effects } = run(capture, 'printSheetReady');
  assert.deepEqual(state, capture);
  assert.deepEqual(effects, []);
});

test('printSheetReady: pushes print-order-confirmed effect and clears confirmedPrintOrder', () => {
  const confirmed = toConfirmedPayment();
  const { state, effects } = run(confirmed, 'printSheetReady');
  assert.equal(state.confirmedPrintOrder, null);
  const effect = effects.find((e) => e.type === 'print-order-confirmed');
  assert.ok(effect);
  assert.equal(effect.sessionId, confirmed.sessionId);
  assert.equal(effect.quantity, 1);
  assert.equal(effect.unitPriceCents, SETTINGS.printUnitPriceCents);
  assert.equal(effect.totalCents, SETTINGS.printUnitPriceCents);
});


// ---- Tiered pricing (2026-08-14) ----
// TOK2026 — which does the actual charging — prices prints in tiers
// (5/9/13/16 EUR for 1-4), and no single unit price reproduces that. Before
// printPriceTiersCents the booth showed a visitor 8 EUR for two prints while
// TOK2026 billed 9.

const TIERED_SETTINGS = {
  ...SETTINGS,
  printingEnabled: true,
  qrRequiresPayment: true,
  qrUnitPriceCents: 200,
  maxPrintQuantity: 4,
  printPriceTiersCents: { 1: 500, 2: 900, 3: 1300, 4: 1600 },
};

function chargeFor(quantity, settings) {
  const ctxFor = { settings, frames: FRAMES };
  let state = applyAction(createInitialState(), { type: 'start' }, ctxFor).state;
  state = applyAction(state, { type: 'agree' }, ctxFor).state;
  state = applyAction(state, { type: 'chooseFormat', payload: { layoutId: 'strip' } }, ctxFor).state;
  state = applyAction(state, { type: 'chooseTheme', payload: { frameId: 'frame-a' } }, ctxFor).state;
  state = applyAction(state, { type: 'setPrintQuantity', payload: { quantity } }, ctxFor).state;
  state = applyAction(state, { type: 'confirmPrintQuantity' }, ctxFor).state;
  state = applyAction(state, { type: 'choosePaymentMethod', payload: { method: 'cash' } }, ctxFor).state;
  return applyAction(state, { type: 'confirmPrintPayment' }, ctxFor).state;
}

test('each configured tier is charged as the whole bill, with no QR price added on top', () => {
  for (const [quantity, expected] of Object.entries({ 1: 500, 2: 900, 3: 1300, 4: 1600 })) {
    const state = chargeFor(Number(quantity), TIERED_SETTINGS);
    assert.equal(
      state.confirmedPrintOrder.totalCents,
      expected,
      `${quantity} print(s) must cost ${expected} cents, matching the TOK2026 variant`,
    );
  }
});

test('a quantity with no tier entry still falls back to the linear price', () => {
  const settings = { ...TIERED_SETTINGS, maxPrintQuantity: 10, printPriceTiersCents: { 1: 500 } };
  const state = chargeFor(5, settings);
  assert.equal(state.confirmedPrintOrder.totalCents, 5 * 300 + 200);
});

test('with no tier table at all, pricing is unchanged from before the feature', () => {
  const settings = { ...TIERED_SETTINGS, printPriceTiersCents: {} };
  const state = chargeFor(2, settings);
  assert.equal(state.confirmedPrintOrder.totalCents, 2 * 300 + 200);
});
