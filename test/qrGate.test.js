'use strict';

/**
 * Covers the QR payment gate added 2026-08-10 (TOK2026 integration,
 * server/tokPayment.js). Kept as a separate file from test/state.test.js,
 * which another session is actively rewriting — this file only exercises
 * the new qrRequiresPayment/qrPaid/quantity-0 behavior, never the
 * pre-existing flow.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PHASES, createInitialState, applyAction } = require('../server/state');

const FRAMES = [{ id: 'f1', active: true, layout: 'strip' }];

function ctx(settingsOverrides) {
  return { settings: { shotsTotal: 4, maxPrintQuantity: 10, ...settingsOverrides }, frames: FRAMES };
}

function toThemeState(settings) {
  let state = createInitialState();
  state = applyAction(state, { type: 'start' }, ctx(settings)).state;
  state = applyAction(state, { type: 'agree' }, ctx(settings)).state;
  state = applyAction(state, { type: 'chooseFormat', payload: { layoutId: 'strip' } }, ctx(settings)).state;
  return state;
}

test('qrRequiresPayment off + printingEnabled off: unaffected, still skips straight to capture (backward compatible default)', () => {
  const settings = ctx({ printingEnabled: false, qrRequiresPayment: false });
  const themeState = toThemeState(settings.settings);
  const { state } = applyAction(themeState, { type: 'chooseTheme', payload: { frameId: 'f1' } }, settings);
  assert.equal(state.phase, PHASES.CAPTURE);
  assert.equal(state.printOrder, null);
});

test('qrRequiresPayment on + printingEnabled off: routes through quantity/payment with printOrder.quantity starting at 0', () => {
  const settings = ctx({ printingEnabled: false, qrRequiresPayment: true });
  const themeState = toThemeState(settings.settings);
  const { state } = applyAction(themeState, { type: 'chooseTheme', payload: { frameId: 'f1' } }, settings);
  assert.equal(state.phase, PHASES.QUANTITY);
  assert.deepEqual(state.printOrder, { quantity: 0 });
});

test('setPrintQuantity: 0 is rejected when qrRequiresPayment is off, accepted when on', () => {
  const offSettings = ctx({ printingEnabled: true, qrRequiresPayment: false });
  const onSettings = ctx({ printingEnabled: false, qrRequiresPayment: true });

  const offState = { ...createInitialState(), phase: PHASES.QUANTITY, printOrder: { quantity: 1 } };
  const offResult = applyAction(offState, { type: 'setPrintQuantity', payload: { quantity: 0 } }, offSettings);
  assert.equal(offResult.state.error, 'invalid_quantity');

  const onState = { ...createInitialState(), phase: PHASES.QUANTITY, printOrder: { quantity: 0 } };
  const onResult = applyAction(onState, { type: 'setPrintQuantity', payload: { quantity: 0 } }, onSettings);
  assert.equal(onResult.state.error, null);
  assert.deepEqual(onResult.state.printOrder, { quantity: 0 });
});

test('confirmPrintPayment with quantity 0 (QR-only): sets qrPaid true, no confirmedPrintOrder, prices at qrUnitPriceCents', () => {
  const settings = ctx({ printingEnabled: false, qrRequiresPayment: true, qrUnitPriceCents: 250 });
  let state = {
    ...createInitialState(),
    phase: PHASES.PAYMENT,
    printOrder: { quantity: 0 },
    paymentMethod: 'sumup',
  };
  const { state: next } = applyAction(state, { type: 'confirmPrintPayment' }, settings);
  assert.equal(next.phase, PHASES.CAPTURE);
  assert.equal(next.qrPaid, true);
  assert.equal(next.confirmedPrintOrder, null); // nothing to print — must not queue a print job
  assert.equal(next.printOrder, null);
  assert.equal(next.paymentMethod, null);
});

test('confirmPrintPayment with quantity > 0 still sets qrPaid true and queues a real confirmedPrintOrder', () => {
  const settings = ctx({ printingEnabled: true, qrRequiresPayment: true, printUnitPriceCents: 300, qrUnitPriceCents: 250 });
  let state = {
    ...createInitialState(),
    phase: PHASES.PAYMENT,
    printOrder: { quantity: 2 },
    paymentMethod: 'cash',
  };
  const { state: next } = applyAction(state, { type: 'confirmPrintPayment' }, settings);
  assert.equal(next.qrPaid, true);
  assert.deepEqual(next.confirmedPrintOrder, {
    quantity: 2, unitPriceCents: 300, totalCents: 2 * 300 + 250, method: 'cash',
  });
});

test('createInitialState defaults qrPaid to false', () => {
  assert.equal(createInitialState().qrPaid, false);
});
