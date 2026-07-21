'use strict';

/**
 * Pure state machine for a single photobooth session.
 *
 * `createInitialState` builds the idle state. `applyAction` takes
 * (state, action, context) and returns { state, effects } where `state`
 * is a brand new object (never mutates the input) and `effects` is an
 * array of side-effect descriptors the caller (server/index.js) should
 * execute (e.g. schedule countdown timers, delete files, update stats).
 *
 * `context` carries things the reducer needs but that are not part of
 * persisted state: settings (shotsTotal etc.) and frames list.
 */

const PHASES = Object.freeze({
  IDLE: 'idle',
  CONSENT: 'consent',
  THEME: 'theme',
  CAPTURE: 'capture',
  SELECT: 'select',
  FILTER: 'filter',
  QR: 'qr',
});

const MIN_PHOTOS_FOR_EARLY_FINISH = 4;
const PICKS_REQUIRED = 4;
const MAX_RETAKE_SHOTS_OVER_TOTAL = 8; // allow up to shotsTotal + this many extra via retake
// Fallbacks only, used if context.settings omits these keys; store.js's
// DEFAULT_SETTINGS is the source of truth in the running app.
const DEFAULT_MAX_PRINT_QUANTITY = 10;
const DEFAULT_PRINT_UNIT_PRICE_CENTS = 300;

const FILTERS = Object.freeze([
  { id: 'none', label: 'No Filter', css: 'none' },
  { id: 'warm', label: 'Warm', css: 'saturate(1.3) sepia(0.15) contrast(1.05)' },
  { id: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(-10deg) contrast(1.05) brightness(1.03)' },
  { id: 'bw', label: 'B&W', css: 'grayscale(1) contrast(1.1)' },
  { id: 'vintage', label: 'Vintage', css: 'sepia(0.35) saturate(0.8) contrast(0.95) brightness(1.02)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.6) contrast(1.15)' },
]);

function genSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createInitialState() {
  return {
    phase: PHASES.IDLE,
    sessionId: null,
    createdAt: null,
    updatedAt: Date.now(),
    frameId: null,
    photos: [], // [{ index, file, takenAt }]
    shotsTaken: 0,
    shotsTotal: 0,
    picks: [], // array of photo indices, in chosen order
    filterId: 'none',
    countdown: null, // number while counting down, else null
    finalUrl: null,
    finalToken: null,
    qrDataUrl: null,
    error: null,
    printOrder: null, // { stage: 'quantity' | 'awaiting_payment', quantity: number } | null
  };
}

function touch(state) {
  return { ...state, updatedAt: Date.now(), error: null };
}

function withError(state, message) {
  return { ...state, error: message };
}

function isValidFrame(frames, frameId) {
  return frames.some((f) => f.id === frameId && f.active);
}

/**
 * @param {object} state current session state
 * @param {{type: string, payload?: object}} action
 * @param {{settings: object, frames: object[]}} context
 * @returns {{state: object, effects: Array<{type: string, [key: string]: any}>}}
 */
function applyAction(state, action, context) {
  const { type, payload = {} } = action || {};
  const { settings, frames } = context;
  const effects = [];

  switch (type) {
    case 'start': {
      if (state.phase !== PHASES.IDLE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const next = touch({
        ...createInitialState(),
        phase: PHASES.CONSENT,
        sessionId: genSessionId(),
        createdAt: Date.now(),
      });
      effects.push({ type: 'session-started' });
      return { state: next, effects };
    }

    case 'agree': {
      if (state.phase !== PHASES.CONSENT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.THEME }), effects };
    }

    case 'cancel': {
      if (![PHASES.CONSENT, PHASES.THEME].includes(state.phase)) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      effects.push({ type: 'session-abandoned', sessionId: state.sessionId });
      return { state: touch(createInitialState()), effects };
    }

    case 'chooseTheme': {
      if (state.phase !== PHASES.THEME) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { frameId } = payload;
      if (!frameId || !isValidFrame(frames, frameId)) {
        return { state: withError(state, 'invalid_frame'), effects };
      }
      const shotsTotal = state.shotsTotal || settings.shotsTotal;
      // If the operator already had enough shots (e.g. came here via
      // changeTheme after finishing capture), skip straight back to
      // selecting rather than forcing more photos.
      const nextPhase = state.shotsTaken >= shotsTotal ? PHASES.SELECT : PHASES.CAPTURE;
      const next = touch({
        ...state,
        phase: nextPhase,
        frameId,
        shotsTotal,
      });
      return { state: next, effects };
    }

    case 'shutter': {
      if (state.phase !== PHASES.CAPTURE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      if (state.countdown !== null) {
        return { state: withError(state, 'countdown_in_progress'), effects };
      }
      if (state.shotsTaken >= state.shotsTotal) {
        return { state: withError(state, 'shots_complete'), effects };
      }
      effects.push({
        type: 'start-countdown',
        seconds: settings.countdownSeconds,
        sessionId: state.sessionId,
      });
      return { state: touch({ ...state, countdown: settings.countdownSeconds }), effects };
    }

    case 'countdownTick': {
      if (state.phase !== PHASES.CAPTURE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, countdown: payload.value }), effects };
    }

    case 'captureNow': {
      if (state.phase !== PHASES.CAPTURE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      effects.push({ type: 'trigger-capture', sessionId: state.sessionId });
      return { state: touch({ ...state, countdown: null }), effects };
    }

    case 'photoRecorded': {
      if (state.phase !== PHASES.CAPTURE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { index, file } = payload;
      const photos = [...state.photos, { index, file, takenAt: Date.now() }];
      const shotsTaken = photos.length;
      const donePhase = shotsTaken >= state.shotsTotal ? PHASES.SELECT : PHASES.CAPTURE;
      return {
        state: touch({ ...state, photos, shotsTaken, phase: donePhase, countdown: null }),
        effects,
      };
    }

    case 'finishEarly': {
      if (state.phase !== PHASES.CAPTURE) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      if (state.photos.length < MIN_PHOTOS_FOR_EARLY_FINISH) {
        return { state: withError(state, 'not_enough_photos'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.SELECT, countdown: null }), effects };
    }

    case 'togglePick': {
      if (state.phase !== PHASES.SELECT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { index } = payload;
      const photoExists = state.photos.some((p) => p.index === index);
      if (!photoExists) {
        return { state: withError(state, 'invalid_index'), effects };
      }
      const already = state.picks.includes(index);
      let picks;
      if (already) {
        picks = state.picks.filter((i) => i !== index);
      } else {
        if (state.picks.length >= PICKS_REQUIRED) {
          return { state: withError(state, 'picks_full'), effects };
        }
        picks = [...state.picks, index];
      }
      return { state: touch({ ...state, picks }), effects };
    }

    case 'retake': {
      if (state.phase !== PHASES.SELECT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const maxShots = settings.shotsTotal + MAX_RETAKE_SHOTS_OVER_TOTAL;
      if (state.shotsTotal >= maxShots) {
        return { state: withError(state, 'max_retakes_reached'), effects };
      }
      const next = touch({
        ...state,
        phase: PHASES.CAPTURE,
        shotsTotal: Math.min(state.shotsTotal + 1, maxShots),
      });
      return { state: next, effects };
    }

    case 'changeTheme': {
      if (state.phase !== PHASES.SELECT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.THEME }), effects };
    }

    case 'confirmPicks': {
      if (state.phase !== PHASES.SELECT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      if (state.picks.length !== PICKS_REQUIRED) {
        return { state: withError(state, 'need_four_picks'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.FILTER }), effects };
    }

    case 'chooseFilter': {
      if (state.phase !== PHASES.FILTER) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { id } = payload;
      if (!FILTERS.some((f) => f.id === id)) {
        return { state: withError(state, 'invalid_filter'), effects };
      }
      return { state: touch({ ...state, filterId: id }), effects };
    }

    case 'confirmFinal': {
      if (state.phase !== PHASES.FILTER) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      effects.push({ type: 'await-final-upload', sessionId: state.sessionId });
      return { state: touch(state), effects };
    }

    case 'finalSaved': {
      if (state.phase !== PHASES.FILTER) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { finalUrl, finalToken, qrDataUrl } = payload;
      effects.push({
        type: 'session-completed',
        sessionId: state.sessionId,
        frameId: state.frameId,
        filterId: state.filterId,
      });
      const next = touch({ ...state, phase: PHASES.QR, finalUrl, finalToken, qrDataUrl });
      return { state: next, effects };
    }

    case 'openPrintOrder': {
      if (state.phase !== PHASES.QR) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      if (state.printOrder !== null) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const next = touch({ ...state, printOrder: { stage: 'quantity', quantity: 1 } });
      return { state: next, effects };
    }

    case 'setPrintQuantity': {
      if (state.phase !== PHASES.QR || !state.printOrder || state.printOrder.stage !== 'quantity') {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { quantity } = payload;
      const maxPrintQuantity = settings.maxPrintQuantity ?? DEFAULT_MAX_PRINT_QUANTITY;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxPrintQuantity) {
        return { state: withError(state, 'invalid_quantity'), effects };
      }
      const next = touch({ ...state, printOrder: { ...state.printOrder, quantity } });
      return { state: next, effects };
    }

    case 'confirmPrintQuantity': {
      if (state.phase !== PHASES.QR || !state.printOrder || state.printOrder.stage !== 'quantity') {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const next = touch({ ...state, printOrder: { ...state.printOrder, stage: 'awaiting_payment' } });
      return { state: next, effects };
    }

    case 'cancelPrintOrder': {
      if (state.phase !== PHASES.QR || state.printOrder === null) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, printOrder: null }), effects };
    }

    case 'confirmPrintPayment': {
      if (state.phase !== PHASES.QR || !state.printOrder || state.printOrder.stage !== 'awaiting_payment') {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { quantity } = state.printOrder;
      const unitPriceCents = settings.printUnitPriceCents ?? DEFAULT_PRINT_UNIT_PRICE_CENTS;
      const totalCents = quantity * unitPriceCents;
      effects.push({
        type: 'print-order-confirmed',
        sessionId: state.sessionId,
        quantity,
        unitPriceCents,
        totalCents,
      });
      const next = touch({ ...state, printOrder: null });
      return { state: next, effects };
    }

    case 'restart': {
      if (state.phase !== PHASES.QR) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch(createInitialState()), effects };
    }

    case 'forceReset': {
      // Internal action used for idle-timeout / abandonment sweeps.
      if (state.phase !== PHASES.IDLE && state.sessionId) {
        effects.push({ type: 'session-abandoned', sessionId: state.sessionId });
      }
      return { state: touch(createInitialState()), effects };
    }

    default:
      return { state: withError(state, 'unknown_action'), effects };
  }
}

module.exports = {
  PHASES,
  FILTERS,
  PICKS_REQUIRED,
  MIN_PHOTOS_FOR_EARLY_FINISH,
  createInitialState,
  applyAction,
  genSessionId,
};
