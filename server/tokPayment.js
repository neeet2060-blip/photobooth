'use strict';

/**
 * TOK2026 payment bridge: mirrors a photobooth print purchase into the
 * separate TOK2026 festival Firebase project (taste-of-korea-3ac1b) as an
 * `expOrders` document, then polls that document for `paymentStatus` so a
 * visitor who pays through the TOK2026 on-site payment flow can unblock the
 * local photobooth session.
 *
 * Fully isolated from server/cloud.js, which talks to a DIFFERENT Firebase
 * project (taste-of-korea-photobooth) for an unrelated purpose (QR photo
 * delivery) — this module never imports or touches that project's data,
 * only mirrors its Admin-SDK-init *style* (lazy init, readCredentialsSafe
 * returning null instead of throwing, warnOnce, a test-injection seam).
 *
 * Must be safe to require with zero credentials/config present: every
 * failure path here degrades to isEnabled() === false rather than
 * throwing, so server boot always succeeds regardless of TOK2026 config.
 */

const fs = require('fs');
const path = require('path');

const { PHASES, priceForQuantity } = require('./state');

const CREDENTIALS_PATH = process.env.TOK2026_FIREBASE_CREDENTIALS
  || path.join(__dirname, '..', 'secrets', 'tok2026-firebase-admin.json');

// Required for the module to be "enabled" — deliberately no hardcoded
// default, unlike BOOTH_KEY below, since writing into the wrong event's
// Firestore subtree would be a real-money mistake.
const EVENT_ID = process.env.TOK2026_EVENT_ID || '';
const BOOTH_KEY = process.env.TOK2026_BOOTH_KEY || 'exp1';

const TOK2026_PROJECT_ID = 'taste-of-korea-3ac1b';
const TOK2026_APP_NAME = 'tok2026';
const POLL_INTERVAL_MS = 4000;

// TOK2026's pollBoothCardPaymentsNow is an unauthenticated onCall (see
// functions/index.js — safe because it only ever confirms a real matching
// SumUp SUCCESSFUL transaction). Invoked here as a plain HTTPS POST
// following the Firebase callable-function wire protocol ({data: {...}} in,
// {result: ...}/{error: ...} out) — no Firebase client SDK needed from a
// pure Admin-SDK/Node process. Best-effort only: the existing paymentStatus
// poll below is still the source of truth, this just makes it fast instead
// of waiting on TOK2026's 1-minute scheduled backstop.
const POLL_BOOTH_CARD_PAYMENTS_URL = `https://europe-west3-${TOK2026_PROJECT_ID}.cloudfunctions.net/pollBoothCardPaymentsNow`;

let cachedDb = null; // real (lazily-initialized) or injected-for-tests Firestore handle
let warnedOnce = false;

let _dispatch = null;
let _getState = null;

// sessionId -> { docId, sessionId, remotePaymentMethod, localPaymentMethod, intervalId }
const activePolls = new Map();
// sessionId -> promise for the in-process setup currently deciding whether
// that session needs to create or resume an order/poll. Both startup recovery
// and live state changes use this so their async Firestore work cannot race.
const sessionSetupOps = new Map();

async function serializeSessionSetup(sessionId, work) {
  const previous = sessionSetupOps.get(sessionId) || Promise.resolve();
  // A failed earlier setup must not permanently block a later retry.
  const current = previous.catch(() => {}).then(work);
  sessionSetupOps.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (sessionSetupOps.get(sessionId) === current) {
      sessionSetupOps.delete(sessionId);
    }
  }
}

function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[tokPayment] ${message}`);
}

// Overridable so tests get a deterministic price table instead of whatever
// data/settings.json happens to hold on the machine running them.
let _readSettings = null;

function readSettingsSafe() {
  try {
    if (_readSettings) return _readSettings();
    // Required lazily to keep this module loadable in tests that never touch
    // settings, and to avoid a load-order dependency on store.js.
    // eslint-disable-next-line global-require
    return require('./store').readSettings();
  } catch (err) {
    return {};
  }
}

function readCredentialsSafe() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Missing file, unreadable, or malformed JSON: treat as "not
    // configured" rather than crashing server boot.
    return null;
  }
}

/**
 * Lazily initializes a NAMED secondary firebase-admin app ('tok2026') and
 * returns a Firestore handle, or null if not configured/available.
 *
 * Only a *successful* handle is cached — a "not configured yet" result
 * re-checks env/credentials on every call (cheap: an env read + a local
 * file read), same reasoning as server/cloud.js's getBucket().
 */
function getDb() {
  if (cachedDb) return cachedDb;

  if (!EVENT_ID) {
    warnOnce('disabled — TOK2026_EVENT_ID is not set.');
    return null;
  }
  const credentials = readCredentialsSafe();
  if (!credentials) {
    warnOnce(`disabled — no valid credentials found at ${CREDENTIALS_PATH}.`);
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    // eslint-disable-next-line global-require
    const { getFirestore } = require('firebase-admin/firestore');
    // Never touch/reuse the DEFAULT app — that belongs to server/cloud.js
    // and points at a completely different Firebase project.
    const existing = admin.getApps().find((a) => a.name === TOK2026_APP_NAME);
    const app = existing || admin.initializeApp({
      credential: admin.cert(credentials),
      projectId: TOK2026_PROJECT_ID,
    }, TOK2026_APP_NAME);
    cachedDb = getFirestore(app);
    return cachedDb;
  } catch (err) {
    warnOnce(`disabled — firebase-admin initialization failed: ${(err && err.message) || err}`);
    return null;
  }
}

/**
 * @returns {boolean} true if the TOK2026 bridge is configured and ready.
 * Safe to call anytime (including with zero credentials/config present).
 */
function isEnabled() {
  return Boolean(getDb());
}

/**
 * Test-only seam: inject a fake Firestore-like object (needs
 * .collection(name).doc(id).collection(name) => {add, doc}) so tests never
 * touch the real firebase-admin SDK or network. Pass null to reset back to
 * the real lazy-init path.
 */
function _setDbForTests(db) {
  cachedDb = db;
}

/**
 * Test-only seam: inject the settings object used for the local-tier price
 * fallback, so a test's expected price doesn't depend on the real
 * data/settings.json. Pass null to reset back to store.readSettings().
 */
function _setSettingsForTests(settings) {
  _readSettings = settings === null ? null : () => settings;
}

/**
 * Called once at server startup. Dependency-injection style (mirrors
 * server/routes.js's registerRoutes(app, deps)) rather than importing
 * server/index.js's internals directly.
 */
function init({ dispatch, getState }) {
  _dispatch = dispatch;
  _getState = getState;
}

function expOrdersCollection(db) {
  return db.collection('events').doc(EVENT_ID).collection('expOrders');
}

function stopPoll(sessionId) {
  const entry = activePolls.get(sessionId);
  if (!entry) return;
  if (entry.intervalId) clearInterval(entry.intervalId);
  activePolls.delete(sessionId);
}

function isPollStillLive(sessionId) {
  if (!_getState) return false;
  const state = _getState();
  return state.sessionId === sessionId && state.phase === PHASES.PAYMENT;
}

/**
 * Any active poll whose session no longer matches the live one, or whose
 * phase has moved away from PAYMENT (paid-and-advanced, canceled, timed
 * out, forceReset, etc), is stale and must stop — otherwise it would keep
 * hammering Firestore for a session the visitor already left behind.
 */
function reconcilePolls(nextState) {
  for (const sessionId of Array.from(activePolls.keys())) {
    const stillLive = nextState.sessionId === sessionId && nextState.phase === PHASES.PAYMENT;
    if (!stillLive) {
      stopPoll(sessionId);
    }
  }
}

function mapToLocalPaymentMethod(remoteMethod) {
  return remoteMethod === 'cash' ? 'cash' : 'sumup';
}

/**
 * Looks up the exp1 menu (events/{EVENT_ID}/expMenus/{BOOTH_KEY}) for a
 * variant whose printQty matches the local print quantity, so the order we
 * write carries the admin's real configured price instead of a guess.
 *
 * Returns null on any miss (menu missing, item missing, no matching
 * variant, malformed doc, or a Firestore error) — callers must fall back
 * to a price-0 placeholder rather than propagate the failure, since a
 * pricing lookup miss must never block the underlying print flow.
 */
async function findPrintMenuVariant(db, quantity) {
  try {
    const snap = await db.collection('events').doc(EVENT_ID).collection('expMenus').doc(BOOTH_KEY).get();
    const items = snap && typeof snap.data === 'function' && snap.data() && Array.isArray(snap.data().items)
      ? snap.data().items : [];
    for (const item of items) {
      const variant = Array.isArray(item.variants)
        ? item.variants.find((v) => v && v.printQty === quantity)
        : null;
      if (variant) return { item, variant };
    }
    return null;
  } catch (err) {
    // Not warnOnce: warnedOnce is a single process-wide latch, and losing
    // sight of a repeatedly failing price lookup is how a whole event's worth
    // of orders can go out mispriced. The caller prices from the booth's local
    // tier table when this returns null.
    console.warn(`[tokPayment] menu price lookup failed, falling back to the local tier table: ${(err && err.message) || err}`);
    return null;
  }
}

async function startOrderForSession(nextState) {
  const db = getDb();
  if (!db) return;

  // Only ever called once nextState.paymentMethod is already set (see
  // onStateChange below) — so this is the visitor's real chosen method, not
  // a guess. A participant who switches method before paying goes through
  // syncOrderPaymentMethod instead of creating a second order.
  const remotePaymentMethod = nextState.paymentMethod === 'cash' ? 'cash' : 'card';
  const localPaymentMethod = mapToLocalPaymentMethod(remotePaymentMethod);
  const { quantity } = nextState.printOrder;
  // quantity 0 means "QR only, no physical print" (2026-08-10 QR payment
  // gate, server/state.js). The admin tags the QR menu variant with
  // printQty:0 so findPrintMenuVariant can match it here.
  const isQrOnly = quantity === 0;
  // 2026-08-14: always 1 — never `quantity`. The visitor buys ONE bundle, and
  // the matched menu variant is already named AND priced for the whole bundle
  // ("인쇄 4장", printQty:4, price 15 = fifteen euros for all four prints).
  // Passing the print count as qty made TOK2026's staff cart multiply that
  // bundle price by the print count a second time, so a €15 four-print order
  // was displayed and charged as "인쇄 4장 ×4 = €60.00", and a €9 two-print
  // order as "인쇄 2장 ×2 = €18.00".
  //
  // The QR-only path already depended on this same reasoning — it forced qty
  // to 1 because quantity(0) would have zeroed the order — but the fix was
  // only applied to that one case. It holds for every print quantity.
  const orderQty = 1;

  const match = await findPrintMenuVariant(db, quantity);
  const fallbackName = isQrOnly ? 'QR 다운로드' : `인쇄 ${quantity}장`;
  const itemId = match ? match.item.id : (isQrOnly ? 'photobooth_qr' : `photobooth_print_${quantity}`);
  const variantId = match ? match.variant.id : undefined;
  const name = match ? `${match.item.name || '인생네컷'} - ${match.variant.name || fallbackName}` : fallbackName;

  // 2026-08-14: a miss used to mean price 0, which put "인쇄 4장 — EUR 0.00"
  // in front of staff on the payment terminal mid-event. findPrintMenuVariant
  // returns null for a Firestore error just as readily as for a genuinely
  // unconfigured menu, and on the venue's phone hotspot that read failed
  // intermittently while the order write moments later still succeeded.
  //
  // The booth already knows what it just quoted the visitor — the same tier
  // table state.js charges from, kept in sync with the TOK2026 menu — so use
  // that rather than billing nothing. Tiers are whole-order cents; menu
  // variant prices are euros.
  //
  // A matched variant is always trusted as-is, including a deliberate 0.
  let price;
  if (match) {
    price = Number(match.variant.price) || 0;
  } else {
    price = priceForQuantity(quantity, readSettingsSafe()) / 100;
    // Deliberately not warnOnce: warnedOnce is a single process-wide latch, so
    // the first warning of any kind silences every later one. Mispricing an
    // order has to be visible every single time it happens.
    console.warn(
      `[tokPayment] no expMenus/${BOOTH_KEY} variant for printQty=${quantity} (unconfigured, or Firestore was `
      + `unreachable for that read) — pricing this order from the booth's local tier table at EUR ${price.toFixed(2)}.`,
    );
  }

  const docData = {
    boothKey: BOOTH_KEY,
    participantCode: 'ONSITE',
    participantName: '인생네컷',
    paymentMethod: remotePaymentMethod,
    paymentStatus: 'unpaid',
    source: 'photobooth',
    sessionId: nextState.sessionId,
    total: price * orderQty,
    items: [{
      itemId,
      name,
      qty: orderQty,
      price,
      ...(variantId ? { variantId } : {}),
    }],
  };

  try {
    // eslint-disable-next-line global-require
    const { FieldValue } = require('firebase-admin/firestore');
    docData.createdAt = FieldValue.serverTimestamp();
  } catch (err) {
    // Extremely unlikely (firebase-admin is already a hard dependency of
    // this process via server/cloud.js) — fall back rather than failing
    // the whole order over a timestamp helper.
    docData.createdAt = Date.now();
  }

  // Pre-generate the doc ID (instead of .add()) so it's known synchronously,
  // before the write even completes — TOK2026's auto-confirmation matches a
  // SumUp transaction back to an order via foreign-tx-id === this doc's own
  // ID, so the deep link needs the ID up front.
  const ref = expOrdersCollection(db).doc();
  try {
    await ref.set(docData);
  } catch (err) {
    warnOnce(`failed to create expOrders doc: ${(err && err.message) || err}`);
    return;
  }

  // The session may have moved on while the (async) create was in flight.
  if (!isPollStillLive(nextState.sessionId)) return;

  // Note: ref.id (the order's own Firestore doc ID) is also the foreign-tx-id
  // TOK2026 expects a matching SumUp deep link to carry — but that deep link
  // is now built and opened from TOK2026's own exp1 admin screen (the actual
  // phone with the SumUp app / Tap to Pay, since this module's control.js
  // tablet can't do Tap to Pay), not from here. See ExpPosPage.jsx's
  // payCardForPendingOrder.
  const intervalId = setInterval(() => {
    pollOnce(nextState.sessionId).catch(() => {});
  }, POLL_INTERVAL_MS);

  activePolls.set(nextState.sessionId, {
    docId: ref.id,
    sessionId: nextState.sessionId,
    remotePaymentMethod,
    localPaymentMethod,
    intervalId,
  });
}

/**
 * Restarts polling for a payment that was already mirrored to TOK2026 before
 * this Node process restarted. The order ID is deliberately rediscovered by
 * sessionId rather than persisted locally, keeping session.json independent
 * from the remote Firestore document shape.
 */
async function resumePollForSession(sessionState) {
  if (!sessionState || !sessionState.sessionId || !isEnabled()) return;
  await serializeSessionSetup(sessionState.sessionId, async () => {
    if (activePolls.has(sessionState.sessionId)) return;

    const db = getDb();
    if (!db) return;

    let snap;
    try {
      // Do not filter paymentStatus here: an order can be paid while this
      // process is down, and must be found then immediately advanced below.
      snap = await expOrdersCollection(db)
        .where('sessionId', '==', sessionState.sessionId)
        .limit(1)
        .get();
    } catch (err) {
      warnOnce(`failed to resume payment poll for session ${sessionState.sessionId}: ${(err && err.message) || err}`);
      return;
    }
    if (!snap || snap.empty || !snap.docs || !snap.docs.length) return;

    const doc = snap.docs[0];
    const remotePaymentMethod = sessionState.paymentMethod === 'cash' ? 'cash' : 'card';
    activePolls.set(sessionState.sessionId, {
      docId: doc.id,
      sessionId: sessionState.sessionId,
      remotePaymentMethod,
      localPaymentMethod: mapToLocalPaymentMethod(remotePaymentMethod),
      intervalId: setInterval(() => {
        pollOnce(sessionState.sessionId).catch(() => {});
      }, POLL_INTERVAL_MS),
    });

    // Do not wait for the next interval: the remote order may have been marked
    // paid while this server was down.
    await pollOnce(sessionState.sessionId);
  });
}

/**
 * A participant can switch between 'sumup' and 'cash' while still on the
 * payment screen (before either is actually confirmed) — this patches the
 * already-created order's paymentMethod in place instead of creating a
 * second order, so TOK2026 staff always see the visitor's current real
 * choice (critical for cash: staff needs to know to collect cash, not wait
 * on a SumUp transaction that will never arrive).
 */
async function syncOrderPaymentMethod(nextState, entry) {
  const remotePaymentMethod = nextState.paymentMethod === 'cash' ? 'cash' : 'card';
  if (entry.remotePaymentMethod === remotePaymentMethod) return;

  const db = getDb();
  if (!db) return;
  try {
    await expOrdersCollection(db).doc(entry.docId).set({ paymentMethod: remotePaymentMethod }, { merge: true });
  } catch (err) {
    warnOnce(`failed to update paymentMethod on expOrders doc ${entry.docId}: ${(err && err.message) || err}`);
    return;
  }
  entry.remotePaymentMethod = remotePaymentMethod;
  entry.localPaymentMethod = mapToLocalPaymentMethod(remotePaymentMethod);
}

/**
 * Best-effort, fire-and-forget nudge to TOK2026's own immediate-confirm
 * callable so a real SumUp payment is picked up within the ~4s local poll
 * interval instead of waiting up to a minute on TOK2026's scheduled
 * backstop. Never throws — a failure here just means this tick relies on
 * the backstop instead, same as if this call didn't exist at all.
 */
async function triggerRemoteConfirmReal() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(POLL_BOOTH_CARD_PAYMENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { boothKey: BOOTH_KEY, eventId: EVENT_ID } }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    // Network hiccup, TOK2026 function cold-start timeout, rate limit, etc.
    // — never fatal, the 4s Firestore poll below and TOK2026's 1-minute
    // backstop both still cover this order regardless.
  }
}

// Test seam (see _setTriggerRemoteConfirmForTests below) — tests must never
// make a real network call to TOK2026's Cloud Functions on every poll tick.
let triggerRemoteConfirm = triggerRemoteConfirmReal;

async function pollOnce(sessionId) {
  const entry = activePolls.get(sessionId);
  if (!entry) return;

  // Stale-poll guard, mirrors runCountdown's isStillValid() idiom in
  // server/index.js: a poll must never act on a session the visitor has
  // since abandoned, or that has moved on through some other path.
  if (!isPollStillLive(sessionId)) {
    stopPoll(sessionId);
    return;
  }

  const db = getDb();
  if (!db) {
    stopPoll(sessionId);
    return;
  }

  // Only card/SumUp orders can ever have a matching SumUp transaction —
  // nudging TOK2026 for a cash order would be a wasted call every tick.
  if (entry.localPaymentMethod === 'sumup') {
    await triggerRemoteConfirm();
    // Re-check once more: the confirm call above may have taken a couple of
    // seconds, during which the visitor could have left this session.
    if (!isPollStillLive(sessionId)) {
      stopPoll(sessionId);
      return;
    }
  }

  let snap;
  try {
    snap = await expOrdersCollection(db).doc(entry.docId).get();
  } catch (err) {
    warnOnce(`poll failed for session ${sessionId}: ${(err && err.message) || err}`);
    return;
  }

  const data = snap && typeof snap.data === 'function' ? snap.data() : null;
  if (!data || data.paymentStatus !== 'paid') return;

  // Re-check after the async Firestore round-trip, same reasoning as above.
  if (!isPollStillLive(sessionId)) {
    stopPoll(sessionId);
    return;
  }

  if (_getState().paymentMethod !== entry.localPaymentMethod) {
    _dispatch({ type: 'choosePaymentMethod', payload: { method: entry.localPaymentMethod } });
  }
  _dispatch({ type: 'confirmPrintPayment' });
  stopPoll(sessionId);
}

/**
 * Called on every state transition (wired into server/index.js's
 * dispatch()). Returns a promise so tests can await the (async) Firestore
 * write; the real caller in index.js fires it without awaiting.
 */
async function onStateChange(prevState, nextState) {
  if (!isEnabled()) return;

  reconcilePolls(nextState);

  // The order is created (or, if one already exists for this session,
  // patched) the moment BOTH a printOrder and a chosen paymentMethod exist
  // — never earlier. Creating it before the method is known would force a
  // guess (previously always defaulted to 'card'), which mattered little
  // for price but is wrong for staff-facing display: a cash order showing
  // paymentMethod:'card' would leave TOK2026's exp1 staff waiting on a
  // SumUp transaction that will never happen instead of collecting cash.
  const ready = nextState.phase === PHASES.PAYMENT
    && Boolean(nextState.printOrder)
    && Boolean(nextState.paymentMethod);
  if (!ready) return;

  await serializeSessionSetup(nextState.sessionId, async () => {
    const entry = activePolls.get(nextState.sessionId);
    if (!entry) {
      await startOrderForSession(nextState);
    } else {
      await syncOrderPaymentMethod(nextState, entry);
    }
  });
}

/**
 * Test-only seam: trigger a single poll tick synchronously instead of
 * waiting on the real 4-second setInterval.
 */
function _pollOnceForTests(sessionId) {
  return pollOnce(sessionId);
}

/**
 * Test-only seam: replace the real network call to TOK2026's
 * pollBoothCardPaymentsNow with a fake (e.g. a spy or a no-op), so tests
 * never hit the network on every poll tick. Pass null to restore the real
 * implementation.
 */
function _setTriggerRemoteConfirmForTests(fn) {
  triggerRemoteConfirm = fn || triggerRemoteConfirmReal;
}

/**
 * Test-only seam: clear any intervals left running by a test so the
 * process can exit cleanly even if a test didn't drive a poll to
 * completion (paid or reconciled-away).
 */
function _stopAllPollsForTests() {
  for (const sessionId of Array.from(activePolls.keys())) {
    stopPoll(sessionId);
  }
}

module.exports = {
  isEnabled,
  init,
  onStateChange,
  resumePollForSession,
  _setDbForTests,
  _setSettingsForTests,
  _pollOnceForTests,
  _stopAllPollsForTests,
  _setTriggerRemoteConfirmForTests,
  CREDENTIALS_PATH,
};
