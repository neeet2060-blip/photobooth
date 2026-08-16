'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PHASES,
  applyAction,
  createInitialState,
  priceForQuantity,
} = require('../server/state');

const context = {
  settings: {
    shotsTotal: 8,
    countdownSeconds: 3,
    printingEnabled: true,
    qrRequiresPayment: false,
    printUnitPriceCents: 9999,
    qrUnitPriceCents: 9999,
    printPriceTiersCents: { '1': 9999, '2': 9999, '3': 9999, '4': 9999 },
    maxPrintQuantity: 99,
  },
  frames: [],
};

test('QR and print quantities 1-4 are always free', () => {
  for (let quantity = 0; quantity <= 4; quantity += 1) {
    assert.equal(priceForQuantity(quantity, context.settings), 0);
  }
});

test('cash starts capture immediately without a payment confirmation', () => {
  for (let quantity = 1; quantity <= 4; quantity += 1) {
    const state = {
      ...createInitialState(),
      phase: PHASES.PAYMENT,
      sessionId: `cash-${quantity}`,
      printOrder: { quantity },
    };

    const { state: next, effects } = applyAction(
      state,
      { type: 'choosePaymentMethod', payload: { method: 'cash' } },
      context,
    );

    assert.equal(next.phase, PHASES.CAPTURE);
    assert.equal(next.printOrder, null);
    assert.equal(next.paymentMethod, null);
    assert.equal(next.qrPaid, true);
    assert.deepEqual(next.confirmedPrintOrder, {
      quantity,
      unitPriceCents: 0,
      totalCents: 0,
      method: 'cash',
    });
    assert.deepEqual(effects, []);
  }
});

test('print quantity is limited to four', () => {
  const state = {
    ...createInitialState(),
    phase: PHASES.QUANTITY,
    sessionId: 'quantity-limit',
    printOrder: { quantity: 4 },
  };
  const { state: next } = applyAction(
    state,
    { type: 'setPrintQuantity', payload: { quantity: 5 } },
    context,
  );
  assert.equal(next.error, 'invalid_quantity');
  assert.equal(next.printOrder.quantity, 4);
});
