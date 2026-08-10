'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { PHASES } = require('../server/state');

function freshTokPayment() {
  delete require.cache[require.resolve('../server/tokPayment')];
  // eslint-disable-next-line global-require
  return require('../server/tokPayment');
}

/**
 * Minimal Firestore-like fake: supports the exact chain tokPayment.js uses
 * — collection(name).doc(id).collection(name).add(data) /
 * .doc(id).get()/.set(patch) — nothing more. Mirrors test/cloud.test.js's
 * makeFakeBucket() convention for a hand-rolled fake over a real SDK mock.
 */
function makeFakeDb() {
  const docs = new Map(); // docId -> data
  let counter = 0;

  function subCollection() {
    return {
      async add(data) {
        counter += 1;
        const docId = `doc${counter}`;
        docs.set(docId, { ...data });
        return { id: docId };
      },
      doc(docId) {
        return {
          async get() {
            const data = docs.get(docId);
            return { exists: Boolean(data), data: () => data };
          },
          async set(patch) {
            docs.set(docId, { ...(docs.get(docId) || {}), ...patch });
          },
        };
      },
    };
  }

  const db = {
    collection() {
      return {
        doc() {
          return { collection: subCollection };
        },
      };
    },
  };

  return {
    db,
    getDoc: (docId) => docs.get(docId),
    setPaymentStatus: (docId, status) => {
      const entry = docs.get(docId);
      if (entry) entry.paymentStatus = status;
    },
    docIds: () => Array.from(docs.keys()),
  };
}

function makeDispatchRecorder(initialState) {
  let state = { ...initialState };
  const dispatched = [];
  const applyKnownActions = (action) => {
    dispatched.push(action);
    if (action.type === 'choosePaymentMethod') {
      state = { ...state, paymentMethod: action.payload.method };
    } else if (action.type === 'confirmPrintPayment') {
      state = { ...state, phase: PHASES.CAPTURE, printOrder: null, paymentMethod: null };
    }
  };
  return {
    dispatch: applyKnownActions,
    getState: () => state,
    dispatched,
    setState: (patch) => { state = { ...state, ...patch }; },
  };
}

// ---- Zero-credentials contract ----

test('isEnabled() is false and onStateChange is a safe no-op with zero credentials/config', async () => {
  delete process.env.TOK2026_FIREBASE_CREDENTIALS;
  delete process.env.TOK2026_EVENT_ID;
  const tokPayment = freshTokPayment();

  assert.equal(tokPayment.isEnabled(), false);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.QUANTITY, printOrder: null, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await assert.doesNotReject(() => tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: null, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 2 }, sessionId: 's1' },
  ));
  assert.deepEqual(recorder.dispatched, []);
});

test('isEnabled() is true once a db is injected for tests', () => {
  delete process.env.TOK2026_FIREBASE_CREDENTIALS;
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const { db } = makeFakeDb();
  tokPayment._setDbForTests(db);
  assert.equal(tokPayment.isEnabled(), true);
  tokPayment._stopAllPollsForTests();
});

// ---- onStateChange: writes an expOrders doc on entering PAYMENT ----

test('onStateChange writes an expOrders-shaped doc when entering PAYMENT with a printOrder', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 3 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: null },
  );

  const docIds = fakeDb.docIds();
  assert.equal(docIds.length, 1);
  const doc = fakeDb.getDoc(docIds[0]);
  assert.equal(doc.boothKey, 'exp1');
  assert.equal(doc.participantCode, 'ONSITE');
  assert.equal(doc.participantName, '인생네컷');
  assert.equal(doc.paymentStatus, 'unpaid');
  assert.equal(doc.source, 'photobooth');
  assert.equal(doc.sessionId, 's1');
  assert.deepEqual(doc.items, [{ itemId: 'photobooth_print_3', name: '인쇄 3장', qty: 3, price: 0 }]);
  assert.ok('createdAt' in doc);

  tokPayment._stopAllPollsForTests();
});

test('onStateChange does not create a second doc on a no-op re-dispatch within PAYMENT', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  const paymentState = { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: null };
  await tokPayment.onStateChange({ phase: PHASES.QUANTITY, printOrder: { quantity: 1 }, sessionId: 's1' }, paymentState);
  // e.g. a countdown-unrelated re-render / no-op action while still in PAYMENT
  await tokPayment.onStateChange(paymentState, { ...paymentState, updatedAt: Date.now() });

  assert.equal(fakeDb.docIds().length, 1);
  tokPayment._stopAllPollsForTests();
});

// ---- Polling: dispatches once paymentStatus becomes "paid" ----

test('_pollOnceForTests dispatches choosePaymentMethod + confirmPrintPayment once paymentStatus is "paid"', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 2 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 2 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 2 }, sessionId: 's1', paymentMethod: null },
  );

  const [docId] = fakeDb.docIds();
  assert.ok(docId);

  // Not paid yet: polling must not dispatch anything.
  await tokPayment._pollOnceForTests('s1');
  assert.deepEqual(recorder.dispatched, []);

  fakeDb.setPaymentStatus(docId, 'paid');
  await tokPayment._pollOnceForTests('s1');

  assert.equal(recorder.dispatched.length, 2);
  assert.equal(recorder.dispatched[0].type, 'choosePaymentMethod');
  assert.equal(recorder.dispatched[1].type, 'confirmPrintPayment');
  assert.equal(recorder.getState().phase, PHASES.CAPTURE);

  // Polling again after payment must be a no-op (interval already cleared).
  const beforeCount = recorder.dispatched.length;
  await tokPayment._pollOnceForTests('s1');
  assert.equal(recorder.dispatched.length, beforeCount);

  tokPayment._stopAllPollsForTests();
});

// ---- Stale/abandoned session guard ----

test('a session change before payment stops the poll and results in no dispatch', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 1 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: null },
  );
  const [docId] = fakeDb.docIds();
  assert.ok(docId);

  // Visitor abandons: session resets to idle before ever paying.
  recorder.setState({ sessionId: null, phase: PHASES.IDLE, printOrder: null, paymentMethod: null });
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1' },
    { phase: PHASES.IDLE, printOrder: null, sessionId: null },
  );

  // Even if the remote doc later gets marked "paid" (e.g. a stray write),
  // a poll for the abandoned session must no-op — the interval driving it
  // was already cleared by the reconciliation above.
  fakeDb.setPaymentStatus(docId, 'paid');
  await tokPayment._pollOnceForTests('s1');

  assert.deepEqual(recorder.dispatched, []);
  tokPayment._stopAllPollsForTests();
});

// ---- Menu price lookup (2026-08-10 review fix: the order must never carry
// a guessed/zero price when the admin has configured a real one) ----

test('onStateChange uses the real exp1 menu price when a matching printQty variant exists', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  // Seed events/test-event/expMenus/exp1 the way an admin would configure it
  // via ExpPosPage's variant editor: a "인생네컷" item whose "인쇄 3장"
  // variant is tagged printQty:3.
  await fakeDb.db.collection('events').doc('test-event').collection('expMenus').doc('exp1').set({
    items: [{
      id: 'exp1_123', name: '인생네컷', price: 0, photo: null,
      variants: [
        { id: 'v_qr', name: 'QR 다운로드', price: 3, photo: null },
        { id: 'v_print3', name: '인쇄 3장', price: 12.5, photo: null, printQty: 3 },
      ],
    }],
  });

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 3 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: null },
  );

  const orderDocIds = fakeDb.docIds().filter((id) => id !== 'exp1');
  assert.equal(orderDocIds.length, 1);
  const doc = fakeDb.getDoc(orderDocIds[0]);
  assert.deepEqual(doc.items, [{ itemId: 'exp1_123', name: '인생네컷 - 인쇄 3장', qty: 3, price: 12.5, variantId: 'v_print3' }]);
  assert.equal(doc.total, 37.5);

  tokPayment._stopAllPollsForTests();
});

// ---- QR-only orders (2026-08-10 QR payment gate, printOrder.quantity 0) ----

test('a quantity-0 (QR-only) printOrder is stored with qty:1 and the real QR price, not price*0', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  // Admin tags the QR variant with printQty:0 to match a QR-only session.
  await fakeDb.db.collection('events').doc('test-event').collection('expMenus').doc('exp1').set({
    items: [{
      id: 'exp1_123', name: '인생네컷', price: 0, photo: null,
      variants: [{ id: 'v_qr', name: 'QR 다운로드', price: 3, photo: null, printQty: 0 }],
    }],
  });

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 0 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, sessionId: 's1', paymentMethod: null },
  );

  const orderDocIds = fakeDb.docIds().filter((id) => id !== 'exp1');
  assert.equal(orderDocIds.length, 1);
  const doc = fakeDb.getDoc(orderDocIds[0]);
  assert.deepEqual(doc.items, [{ itemId: 'exp1_123', name: '인생네컷 - QR 다운로드', qty: 1, price: 3, variantId: 'v_qr' }]);
  assert.equal(doc.total, 3);

  tokPayment._stopAllPollsForTests();
});

test('a quantity-0 order with no configured QR variant falls back to a 0-price placeholder (never quantity*price)', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 0 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, sessionId: 's1', paymentMethod: null },
  );

  const [docId] = fakeDb.docIds();
  const doc = fakeDb.getDoc(docId);
  assert.deepEqual(doc.items, [{ itemId: 'photobooth_qr', name: 'QR 다운로드', qty: 1, price: 0 }]);
  assert.equal(doc.total, 0);

  tokPayment._stopAllPollsForTests();
});

after(() => {
  delete process.env.TOK2026_FIREBASE_CREDENTIALS;
  delete process.env.TOK2026_EVENT_ID;
  delete process.env.TOK2026_BOOTH_KEY;
});
