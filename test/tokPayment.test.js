'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { PHASES } = require('../server/state');

function freshTokPayment() {
  delete require.cache[require.resolve('../server/tokPayment')];
  // eslint-disable-next-line global-require
  const tokPayment = require('../server/tokPayment');
  // Every poll tick for a card/sumup order now fires a best-effort network
  // call to TOK2026's pollBoothCardPaymentsNow (see server/tokPayment.js) —
  // tests must never actually hit the network, so this is disabled by
  // default here. Tests that specifically want to assert it's called
  // override it again after this via _setTriggerRemoteConfirmForTests.
  tokPayment._setTriggerRemoteConfirmForTests(async () => {});
  // When the TOK2026 menu lookup misses, the order is priced from the booth's
  // own tier table. Pin that table here so no test's expected price depends on
  // whatever data/settings.json holds on the machine running the suite.
  tokPayment._setSettingsForTests({
    printPriceTiersCents: { 0: 200, 1: 500, 2: 900, 3: 1300, 4: 1500 },
    qrUnitPriceCents: 200,
    qrRequiresPayment: true,
  });
  return tokPayment;
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
  let onQueryGet = null;
  let queryGetCount = 0;

  function subCollection() {
    const query = (filters = [], limitCount = null) => ({
      where(field, operator, value) {
        assert.equal(operator, '==');
        return query([...filters, [field, value]], limitCount);
      },
      limit(count) {
        return query(filters, count);
      },
      async get() {
        queryGetCount += 1;
        const matches = Array.from(docs.entries())
          .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
          .slice(0, limitCount || undefined)
          .map(([id, data]) => ({ id, data: () => data }));
        if (onQueryGet) await onQueryGet();
        return { empty: matches.length === 0, docs: matches };
      },
    });
    return {
      async add(data) {
        counter += 1;
        const docId = `doc${counter}`;
        docs.set(docId, { ...data });
        return { id: docId };
      },
      // Real Firestore's collection.doc() with no argument pre-generates a
      // random ID before any write happens — tokPayment.js relies on this
      // (see startOrderForSession) to build the SumUp deep link's
      // foreign-tx-id from the order's own doc ID synchronously.
      doc(docId) {
        const id = docId || `doc${(counter += 1)}`;
        return {
          id,
          async get() {
            const data = docs.get(id);
            return { exists: Boolean(data), data: () => data };
          },
          async set(patch) {
            docs.set(id, { ...(docs.get(id) || {}), ...patch });
          },
        };
      },
      where(field, operator, value) {
        return query().where(field, operator, value);
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
    setOnQueryGet: (callback) => { onQueryGet = callback; },
    queryGetCount: () => queryGetCount,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
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

async function seedUnpaidOrder(fakeDb, sessionId, paymentMethod = 'cash') {
  const tokPayment = freshTokPayment();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId,
    phase: PHASES.PAYMENT,
    printOrder: { quantity: 1 },
    paymentMethod,
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });
  await tokPayment.onStateChange(
    { sessionId, phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: null },
    recorder.getState(),
  );
  tokPayment._stopAllPollsForTests();
  return fakeDb.docIds()[0];
}

// ---- Restart recovery ----

test('resumePollForSession rediscovers an unpaid order and resumes its poll', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const fakeDb = makeFakeDb();
  const docId = await seedUnpaidOrder(fakeDb, 's-resume');

  const tokPayment = freshTokPayment();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-resume', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'cash',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.resumePollForSession(recorder.getState());
  assert.deepEqual(recorder.dispatched, []);

  fakeDb.setPaymentStatus(docId, 'paid');
  await tokPayment._pollOnceForTests('s-resume');
  assert.deepEqual(recorder.dispatched.map((action) => action.type), ['confirmPrintPayment']);
  tokPayment._stopAllPollsForTests();
});

test('resumePollForSession is a no-op when no unpaid remote order exists', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-missing', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'cash',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.resumePollForSession(recorder.getState());
  await tokPayment._pollOnceForTests('s-missing');
  assert.deepEqual(recorder.dispatched, []);
  tokPayment._stopAllPollsForTests();
});

test('resumePollForSession immediately processes an order paid during restart recovery', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const fakeDb = makeFakeDb();
  const docId = await seedUnpaidOrder(fakeDb, 's-immediate', 'sumup');
  fakeDb.setOnQueryGet(() => {
    fakeDb.setPaymentStatus(docId, 'paid');
    fakeDb.setOnQueryGet(null);
  });

  const tokPayment = freshTokPayment();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-immediate', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'sumup',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.resumePollForSession(recorder.getState());
  assert.deepEqual(recorder.dispatched.map((action) => action.type), [
    'confirmPrintPayment',
  ]);
  tokPayment._stopAllPollsForTests();
});

test('resumePollForSession finds an order that was already paid before restart recovery', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const fakeDb = makeFakeDb();
  const docId = await seedUnpaidOrder(fakeDb, 's-already-paid', 'cash');
  fakeDb.setPaymentStatus(docId, 'paid');

  const tokPayment = freshTokPayment();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-already-paid', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'cash',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.resumePollForSession(recorder.getState());
  assert.deepEqual(recorder.dispatched.map((action) => action.type), ['confirmPrintPayment']);
  tokPayment._stopAllPollsForTests();
});

test('overlapping state changes reserve one session setup and create only one order', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-overlap-start', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'cash',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  const paymentState = recorder.getState();
  await Promise.all([
    tokPayment.onStateChange({ ...paymentState, paymentMethod: null }, paymentState),
    tokPayment.onStateChange({ ...paymentState, paymentMethod: null }, paymentState),
  ]);

  assert.equal(fakeDb.docIds().length, 1);
  tokPayment._stopAllPollsForTests();
});

test('overlapping restart recovery performs one query and installs one poll setup', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const fakeDb = makeFakeDb();
  await seedUnpaidOrder(fakeDb, 's-overlap-resume');
  const gate = deferred();
  let firstQuery = true;
  fakeDb.setOnQueryGet(async () => {
    if (!firstQuery) return;
    firstQuery = false;
    await gate.promise;
  });

  const tokPayment = freshTokPayment();
  tokPayment._setDbForTests(fakeDb.db);
  const recorder = makeDispatchRecorder({
    sessionId: 's-overlap-resume', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: 'cash',
  });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  const first = tokPayment.resumePollForSession(recorder.getState());
  await Promise.resolve();
  const second = tokPayment.resumePollForSession(recorder.getState());
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(fakeDb.queryGetCount(), 1);
  tokPayment._stopAllPollsForTests();
});

// ---- onStateChange: writes an expOrders doc once a paymentMethod is chosen ----

test('onStateChange does NOT create an order while paymentMethod is still null (entering PAYMENT alone)', async () => {
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

  assert.equal(fakeDb.docIds().length, 0);
  tokPayment._stopAllPollsForTests();
});

test('onStateChange writes an expOrders-shaped doc once a paymentMethod is chosen', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  // Entering PAYMENT alone creates nothing (see test above); the order is
  // only written once choosePaymentMethod actually fires.
  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 3 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: null },
  );
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: null },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: 'sumup' },
  );

  const docIds = fakeDb.docIds();
  assert.equal(docIds.length, 1);
  const doc = fakeDb.getDoc(docIds[0]);
  assert.equal(doc.boothKey, 'exp1');
  assert.equal(doc.participantCode, 'ONSITE');
  assert.equal(doc.participantName, '인생네컷');
  assert.equal(doc.paymentMethod, 'card'); // local 'sumup' -> remote 'card', see mapToLocalPaymentMethod
  assert.equal(doc.paymentStatus, 'unpaid');
  assert.equal(doc.source, 'photobooth');
  assert.equal(doc.sessionId, 's1');
  // qty is 1, not 3: one "인쇄 3장" bundle. See the bundle-pricing test below.
  // No menu is seeded here, so the price comes from the local tier table
  // (1300 cents -> 13), not from a zero placeholder.
  assert.deepEqual(doc.items, [{ itemId: 'photobooth_print_3', name: '인쇄 3장', qty: 1, price: 13 }]);
  assert.equal(doc.total, 13);
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

  const paymentState = { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'sumup' };
  await tokPayment.onStateChange({ phase: PHASES.QUANTITY, printOrder: { quantity: 1 }, sessionId: 's1' }, paymentState);
  // e.g. a countdown-unrelated re-render / no-op action while still in PAYMENT
  await tokPayment.onStateChange(paymentState, { ...paymentState, updatedAt: Date.now() });

  assert.equal(fakeDb.docIds().length, 1);
  tokPayment._stopAllPollsForTests();
});

test('switching payment method mid-PAYMENT patches the existing order instead of creating a second one', async () => {
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
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: null },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'sumup' },
  );
  const [docId] = fakeDb.docIds();
  assert.equal(fakeDb.getDoc(docId).paymentMethod, 'card');

  // Participant changes their mind: sumup -> cash, still on the payment screen.
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'sumup' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'cash' },
  );

  assert.equal(fakeDb.docIds().length, 1); // still just the one order
  assert.equal(fakeDb.getDoc(docId).paymentMethod, 'cash'); // patched in place

  tokPayment._stopAllPollsForTests();
});

test('a cash order is confirmed by the same background poll as a card order (staff confirms on the TOK2026 side, not a local click)', async () => {
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
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: null },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'cash' },
  );
  const [docId] = fakeDb.docIds();
  assert.equal(fakeDb.getDoc(docId).paymentMethod, 'cash');

  // Not yet confirmed by staff: polling must not dispatch anything.
  await tokPayment._pollOnceForTests('s1');
  assert.deepEqual(recorder.dispatched, []);

  // Staff confirms cash receipt on TOK2026's exp1 pending-orders screen —
  // simulated here as a direct paymentStatus flip, exactly like a card
  // order's SumUp confirmation would look from this module's point of view.
  fakeDb.setPaymentStatus(docId, 'paid');
  await tokPayment._pollOnceForTests('s1');

  assert.equal(recorder.dispatched.length, 2);
  assert.equal(recorder.dispatched[0].type, 'choosePaymentMethod');
  assert.equal(recorder.dispatched[0].payload.method, 'cash');
  assert.equal(recorder.dispatched[1].type, 'confirmPrintPayment');

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
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 2 }, sessionId: 's1', paymentMethod: null },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 2 }, sessionId: 's1', paymentMethod: 'sumup' },
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
  await tokPayment.onStateChange(
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: null },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'sumup' },
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
    { phase: PHASES.PAYMENT, printOrder: { quantity: 3 }, sessionId: 's1', paymentMethod: 'sumup' },
  );

  const orderDocIds = fakeDb.docIds().filter((id) => id !== 'exp1');
  assert.equal(orderDocIds.length, 1);
  const doc = fakeDb.getDoc(orderDocIds[0]);
  // A print variant's price is the price of the WHOLE bundle — 12.5 buys all
  // three prints — so the order is one unit of it. Storing qty:3 here made
  // TOK2026's staff cart bill 12.5 x 3; on 2026-08-14 a real €15 four-print
  // order was displayed as "인쇄 4장 ×4 = €60.00".
  assert.deepEqual(doc.items, [{ itemId: 'exp1_123', name: '인생네컷 - 인쇄 3장', qty: 1, price: 12.5, variantId: 'v_print3' }]);
  assert.equal(doc.total, 12.5);

  tokPayment._stopAllPollsForTests();
});

test('a print bundle is billed once, not once per print (2026-08-14: 4 prints @ EUR15 showed as EUR60)', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  // The live de-dietzenbach-2026 menu as the admin configured it: one variant
  // per print count, each priced for the whole bundle.
  await fakeDb.db.collection('events').doc('test-event').collection('expMenus').doc('exp1').set({
    items: [{
      id: 'exp1_123', name: '인생네컷', price: 0, photo: null,
      variants: [
        { id: 'v_qr', name: 'QR 다운로드', price: 2, photo: null, printQty: 0 },
        { id: 'v_p1', name: '인쇄 1장', price: 5, photo: null, printQty: 1 },
        { id: 'v_p2', name: '인쇄 2장', price: 9, photo: null, printQty: 2 },
        { id: 'v_p3', name: '인쇄 3장', price: 13, photo: null, printQty: 3 },
        { id: 'v_p4', name: '인쇄 4장', price: 15, photo: null, printQty: 4 },
      ],
    }],
  });

  for (const [quantity, expected] of [[1, 5], [2, 9], [3, 13], [4, 15], [0, 2]]) {
    const recorder = makeDispatchRecorder({ sessionId: `s${quantity}`, phase: PHASES.PAYMENT, printOrder: { quantity }, paymentMethod: null });
    tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });
    await tokPayment.onStateChange(
      { phase: PHASES.QUANTITY, printOrder: { quantity }, sessionId: `s${quantity}` },
      { phase: PHASES.PAYMENT, printOrder: { quantity }, sessionId: `s${quantity}`, paymentMethod: 'sumup' },
    );

    const orderDocIds = fakeDb.docIds().filter((id) => id !== 'exp1');
    const doc = fakeDb.getDoc(orderDocIds[orderDocIds.length - 1]);
    assert.equal(doc.items.length, 1);
    assert.equal(doc.items[0].qty, 1, `quantity ${quantity} must be billed as one bundle`);
    assert.equal(doc.items[0].price, expected);
    assert.equal(doc.total, expected, `quantity ${quantity} must total ${expected}, not ${expected * (quantity || 1)}`);
  }

  tokPayment._stopAllPollsForTests();
});

test('an unreachable/unconfigured menu prices from the local tier table, never 0 (2026-08-14 live incident)', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  // No expMenus doc at all — the same null that findPrintMenuVariant returns
  // when the Firestore read throws, which is what happened at the venue: the
  // menu read timed out on the phone hotspot while the order write moments
  // later succeeded, so staff were shown "인쇄 4장 - EUR 0.00" to charge.
  for (const [quantity, expected] of [[0, 2], [1, 5], [2, 9], [3, 13], [4, 15]]) {
    const sessionId = `s${quantity}`;
    const recorder = makeDispatchRecorder({ sessionId, phase: PHASES.PAYMENT, printOrder: { quantity }, paymentMethod: null });
    tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });
    await tokPayment.onStateChange(
      { phase: PHASES.QUANTITY, printOrder: { quantity }, sessionId },
      { phase: PHASES.PAYMENT, printOrder: { quantity }, sessionId, paymentMethod: 'sumup' },
    );

    const ids = fakeDb.docIds();
    const doc = fakeDb.getDoc(ids[ids.length - 1]);
    assert.equal(doc.items[0].qty, 1);
    assert.equal(doc.items[0].price, expected, `quantity ${quantity} must fall back to ${expected}`);
    assert.equal(doc.total, expected);
  }

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
    { phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, sessionId: 's1', paymentMethod: 'sumup' },
  );

  const orderDocIds = fakeDb.docIds().filter((id) => id !== 'exp1');
  assert.equal(orderDocIds.length, 1);
  const doc = fakeDb.getDoc(orderDocIds[0]);
  assert.deepEqual(doc.items, [{ itemId: 'exp1_123', name: '인생네컷 - QR 다운로드', qty: 1, price: 3, variantId: 'v_qr' }]);
  assert.equal(doc.total, 3);

  tokPayment._stopAllPollsForTests();
});

test('a quantity-0 order with no configured QR variant falls back to the local QR price, never 0 (never quantity*price either)', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 0 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 0 }, sessionId: 's1', paymentMethod: 'sumup' },
  );

  const [docId] = fakeDb.docIds();
  const doc = fakeDb.getDoc(docId);
  assert.deepEqual(doc.items, [{ itemId: 'photobooth_qr', name: 'QR 다운로드', qty: 1, price: 2 }]);
  assert.equal(doc.total, 2);

  tokPayment._stopAllPollsForTests();
});

// ---- Real SumUp auto-confirmation (2026-08-11) ----

test('a poll tick nudges TOK2026s immediate-confirm callable for a card/sumup order', async () => {
  process.env.TOK2026_EVENT_ID = 'test-event';
  const tokPayment = freshTokPayment();
  const fakeDb = makeFakeDb();
  tokPayment._setDbForTests(fakeDb.db);

  let callCount = 0;
  tokPayment._setTriggerRemoteConfirmForTests(async () => { callCount += 1; });

  const recorder = makeDispatchRecorder({ sessionId: 's1', phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, paymentMethod: null });
  tokPayment.init({ dispatch: recorder.dispatch, getState: recorder.getState });

  await tokPayment.onStateChange(
    { phase: PHASES.QUANTITY, printOrder: { quantity: 1 }, sessionId: 's1' },
    { phase: PHASES.PAYMENT, printOrder: { quantity: 1 }, sessionId: 's1', paymentMethod: 'sumup' },
  );

  await tokPayment._pollOnceForTests('s1');
  assert.equal(callCount, 1);

  tokPayment._stopAllPollsForTests();
});

after(() => {
  delete process.env.TOK2026_FIREBASE_CREDENTIALS;
  delete process.env.TOK2026_EVENT_ID;
  delete process.env.TOK2026_BOOTH_KEY;
});
