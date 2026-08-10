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

const { PHASES } = require('./state');

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

// Public affiliate credentials (safe to embed — already shipped in TOK2026's
// own client bundle, src/lib/constants.js). Used only to build a
// sumupmerchant:// deep link; the real merchant secret (SUMUP_API_KEY) never
// leaves TOK2026's Cloud Functions and this module never touches it.
const SUMUP_AFFILIATE_KEY = 'sup_afk_kSOjqv0UaciJXkW5C2wq9kMoj04cp8DX';
const SUMUP_APP_ID = 'MGA74PYT';

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

// sessionId -> { docId, sessionId, localPaymentMethod, deepLink, intervalId }
const activePolls = new Map();

function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[tokPayment] ${message}`);
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
    warnOnce(`menu price lookup failed, falling back to a 0-price placeholder: ${(err && err.message) || err}`);
    return null;
  }
}

async function startOrderForSession(nextState) {
  const db = getDb();
  if (!db) return;

  // paymentMethod is not yet chosen at the instant a session freshly enters
  // PAYMENT in the current state machine (choosePaymentMethod is always a
  // later, separate action) — but stay defensive in case that ever changes.
  // 'card' is a best-effort guess either way; the actual charged amount
  // always comes from TOK2026's own configured menu price (looked up below),
  // never guessed here.
  const remotePaymentMethod = nextState.paymentMethod === 'cash' ? 'cash' : 'card';
  const localPaymentMethod = mapToLocalPaymentMethod(remotePaymentMethod);
  const { quantity } = nextState.printOrder;
  // quantity 0 means "QR only, no physical print" (2026-08-10 QR payment
  // gate, server/state.js). There's still exactly one QR being purchased,
  // so the stored line item's qty must be 1 — using quantity(0) directly
  // would price the whole order at 0 regardless of the QR's real price.
  // The admin tags the QR menu variant with printQty:0 to match it here.
  const isQrOnly = quantity === 0;
  const orderQty = isQrOnly ? 1 : quantity;

  const match = await findPrintMenuVariant(db, quantity);
  const price = match ? Number(match.variant.price) || 0 : 0;
  const fallbackName = isQrOnly ? 'QR 다운로드' : `인쇄 ${quantity}장`;
  const itemId = match ? match.item.id : (isQrOnly ? 'photobooth_qr' : `photobooth_print_${quantity}`);
  const variantId = match ? match.variant.id : undefined;
  const name = match ? `${match.item.name || '인생네컷'} - ${match.variant.name || fallbackName}` : fallbackName;
  if (!match) {
    warnOnce(`no expMenus/${BOOTH_KEY} variant with printQty=${quantity} found — order will be created with price 0 until an admin configures it.`);
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

  const deepLink = `sumupmerchant://pay/1.0?amount=${docData.total.toFixed(2)}&currency=EUR`
    + `&affiliate-key=${SUMUP_AFFILIATE_KEY}&app-id=${SUMUP_APP_ID}`
    + `&title=${encodeURIComponent(name)}&foreign-tx-id=${encodeURIComponent(ref.id)}`;

  const intervalId = setInterval(() => {
    pollOnce(nextState.sessionId).catch(() => {});
  }, POLL_INTERVAL_MS);

  activePolls.set(nextState.sessionId, {
    docId: ref.id,
    sessionId: nextState.sessionId,
    localPaymentMethod,
    deepLink,
    intervalId,
  });
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

  const enteredPaymentWithOrder = nextState.phase === PHASES.PAYMENT
    && Boolean(nextState.printOrder)
    && (prevState.phase !== PHASES.PAYMENT || !prevState.printOrder);

  if (enteredPaymentWithOrder) {
    await startOrderForSession(nextState);
  }
}

/**
 * Returns the SumUp deep-link URL for the session's current active order,
 * or null if there is no active order (bridge disabled, not yet created, or
 * the session has moved past PAYMENT). Called from server/routes.js's
 * GET /api/tok-payment-link, which control.js hits right before opening the
 * SumUp app so the deep link's foreign-tx-id always matches a real,
 * already-written expOrders doc.
 */
function getDeepLink(sessionId) {
  const entry = activePolls.get(sessionId);
  return entry ? entry.deepLink : null;
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
  getDeepLink,
  _setDbForTests,
  _pollOnceForTests,
  _stopAllPollsForTests,
  _setTriggerRemoteConfirmForTests,
  CREDENTIALS_PATH,
};
