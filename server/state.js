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
 *
 * Visitor flow: idle -> consent -> format (strip/grid) -> theme (frame
 * design, filtered by the chosen format) -> [quantity -> payment, when
 * settings.printingEnabled OR settings.qrRequiresPayment] -> capture ->
 * select -> filter -> qr. Payment (if any) happens up front, before a
 * single photo is taken, and is remembered as `confirmedPrintOrder` until
 * the print-ready sheet actually exists on disk (see 'printSheetReady').
 * When only qrRequiresPayment is on (no printer this event), printOrder
 * starts at quantity 0 ("QR only") — paying still sets `qrPaid`, but never
 * queues a `confirmedPrintOrder` (see 'confirmPrintPayment'). Every path
 * into 'capture' when qrRequiresPayment is on passes through
 * 'confirmPrintPayment' first, which is what actually sets `qrPaid: true`
 * — callers that release the QR (see finalSaved/'qr' phase) rely on that
 * structural guarantee rather than re-checking `qrPaid` themselves.
 */

const PHASES = Object.freeze({
  IDLE: 'idle',
  CONSENT: 'consent',
  FORMAT: 'format',
  THEME: 'theme',
  QUANTITY: 'quantity',
  PAYMENT: 'payment',
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
const DEFAULT_QR_PRICE_CENTS = 300; // fallback only; settings.qrUnitPriceCents is the real source

const PAYMENT_METHODS = Object.freeze(['sumup', 'cash']);

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
    layoutId: null, // 'strip' | 'grid', chosen in the format phase
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
    printOrder: null, // { quantity: number } | null — only during quantity/payment phases. quantity 0 means "QR only, no physical print" (only reachable when settings.qrRequiresPayment is on).
    paymentMethod: null, // 'sumup' | 'cash' | null — chosen during the payment phase
    // Set once payment is confirmed (before capture starts); consumed by
    // 'printSheetReady' once the print.jpg sheet actually exists on disk.
    confirmedPrintOrder: null, // { quantity, unitPriceCents, totalCents, method } | null
    // Set true by 'confirmPrintPayment' (2026-08-10, TOK2026 integration).
    // When settings.qrRequiresPayment is on, QR delivery must not happen
    // until this is true.
    qrPaid: false,
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

function isValidLayout(frames, layoutId) {
  return frames.some((f) => f.active && f.layout === layoutId);
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
      return { state: touch({ ...state, phase: PHASES.FORMAT }), effects };
    }

    case 'cancel': {
      if (![PHASES.CONSENT, PHASES.FORMAT, PHASES.THEME, PHASES.QUANTITY, PHASES.PAYMENT].includes(state.phase)) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      effects.push({ type: 'session-abandoned', sessionId: state.sessionId });
      return { state: touch(createInitialState()), effects };
    }

    case 'chooseFormat': {
      if (state.phase !== PHASES.FORMAT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { layoutId } = payload;
      if (!layoutId || !isValidLayout(frames, layoutId)) {
        return { state: withError(state, 'invalid_layout'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.THEME, layoutId }), effects };
    }

    case 'chooseTheme': {
      if (state.phase !== PHASES.THEME) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { frameId } = payload;
      const frame = frames.find((f) => f.id === frameId && f.active);
      if (!frame || frame.layout !== state.layoutId) {
        return { state: withError(state, 'invalid_frame'), effects };
      }
      const shotsTotal = state.shotsTotal || settings.shotsTotal;
      // If the operator already had enough shots (e.g. came here via
      // changeTheme after finishing capture), skip straight back to
      // selecting — payment (if any) already happened earlier in this
      // same session. Otherwise, a paid event routes through quantity ->
      // payment first; an unpaid one (no printer this event) goes
      // straight to capture, same as before this feature existed.
      let nextPhase;
      let printOrder = state.printOrder;
      if (state.shotsTaken >= shotsTotal) {
        nextPhase = PHASES.SELECT;
      } else if (settings.printingEnabled || settings.qrRequiresPayment) {
        // qrRequiresPayment alone (printingEnabled off) still needs a
        // payment step for the QR itself — printOrder.quantity starts at 0
        // in that case (see createInitialState's printOrder comment).
        nextPhase = PHASES.QUANTITY;
        printOrder = { quantity: settings.printingEnabled ? 1 : 0 };
      } else {
        nextPhase = PHASES.CAPTURE;
      }
      const next = touch({
        ...state,
        phase: nextPhase,
        frameId,
        shotsTotal,
        printOrder,
      });
      return { state: next, effects };
    }

    case 'setPrintQuantity': {
      if (state.phase !== PHASES.QUANTITY || !state.printOrder) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { quantity } = payload;
      const maxPrintQuantity = settings.maxPrintQuantity ?? DEFAULT_MAX_PRINT_QUANTITY;
      // 0 is only a valid choice when QR itself is a paid item — otherwise
      // "0 prints" would mean paying for literally nothing.
      const minQuantity = settings.qrRequiresPayment ? 0 : 1;
      if (!Number.isInteger(quantity) || quantity < minQuantity || quantity > maxPrintQuantity) {
        return { state: withError(state, 'invalid_quantity'), effects };
      }
      const next = touch({ ...state, printOrder: { ...state.printOrder, quantity } });
      return { state: next, effects };
    }

    case 'confirmPrintQuantity': {
      if (state.phase !== PHASES.QUANTITY || !state.printOrder) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.PAYMENT }), effects };
    }

    case 'backToQuantity': {
      if (state.phase !== PHASES.PAYMENT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      return { state: touch({ ...state, phase: PHASES.QUANTITY, paymentMethod: null }), effects };
    }

    case 'choosePaymentMethod': {
      if (state.phase !== PHASES.PAYMENT) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { method } = payload;
      if (!PAYMENT_METHODS.includes(method)) {
        return { state: withError(state, 'invalid_payment_method'), effects };
      }
      return { state: touch({ ...state, paymentMethod: method }), effects };
    }

    case 'confirmPrintPayment': {
      if (state.phase !== PHASES.PAYMENT || !state.printOrder || !state.paymentMethod) {
        return { state: withError(state, 'invalid_action'), effects };
      }
      const { quantity } = state.printOrder;
      const unitPriceCents = settings.printUnitPriceCents ?? DEFAULT_PRINT_UNIT_PRICE_CENTS;
      const qrUnitPriceCents = settings.qrUnitPriceCents ?? DEFAULT_QR_PRICE_CENTS;
      // quantity 0 means "QR only" (see printOrder comment in
      // createInitialState) — its price is qrUnitPriceCents, not
      // quantity * unitPriceCents (which would be 0 and undercharge).
      const totalCents = quantity > 0
        ? quantity * unitPriceCents + (settings.qrRequiresPayment ? qrUnitPriceCents : 0)
        : qrUnitPriceCents;
      // Deferred: the print.jpg sheet doesn't exist yet (capture hasn't
      // happened), so the actual print-queue effect fires later, from
      // 'printSheetReady', once the file is really on disk. A quantity-0
      // (QR-only) order never queues a print job at all.
      const next = touch({
        ...state,
        phase: PHASES.CAPTURE,
        printOrder: null,
        paymentMethod: null,
        qrPaid: true,
        confirmedPrintOrder: quantity > 0
          ? { quantity, unitPriceCents, totalCents, method: state.paymentMethod }
          : null,
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

    case 'printSheetReady': {
      // Internal action dispatched by the /api/print-sheet route once
      // print.jpg is actually saved to disk. Not phase-gated: by the time
      // this fires the session has already moved on to filter/qr. A no-op
      // when this session never had a confirmed (paid) print order.
      if (!state.confirmedPrintOrder) {
        return { state, effects };
      }
      const { quantity, unitPriceCents, totalCents } = state.confirmedPrintOrder;
      effects.push({
        type: 'print-order-confirmed',
        sessionId: state.sessionId,
        quantity,
        unitPriceCents,
        totalCents,
      });
      return { state: touch({ ...state, confirmedPrintOrder: null }), effects };
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
  PAYMENT_METHODS,
  PICKS_REQUIRED,
  MIN_PHOTOS_FOR_EARLY_FINISH,
  createInitialState,
  applyAction,
  genSessionId,
};
