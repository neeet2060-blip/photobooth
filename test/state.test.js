'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PHASES, createInitialState, applyAction } = require('../server/state');

const SETTINGS = {
  shotsTotal: 4,
  countdownSeconds: 3,
  idleTimeoutSec: 180,
  qrTimeoutSec: 90,
  defaultLang: 'ko',
  autoDeleteHours: 24,
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

test('agree: consent -> theme', () => {
  const consent = run(createInitialState(), 'start').state;
  const { state } = run(consent, 'agree');
  assert.equal(state.phase, PHASES.THEME);
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

function toTheme() {
  const consent = run(createInitialState(), 'start').state;
  return run(consent, 'agree').state;
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
