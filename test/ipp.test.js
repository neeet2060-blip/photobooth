'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ipp = require('../server/ipp');

// ---- response parsing ------------------------------------------------------

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function attr(tag, name, value) {
  const n = Buffer.from(name, 'utf8');
  const v = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag]), u16(n.length), n, u16(v.length), v]);
}

/** Extra values of a multi-valued attribute carry a zero-length name. */
function additionalValue(tag, value) {
  const v = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag]), u16(0), u16(v.length), v]);
}

function response(statusCode, body) {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0200, 0);
  head.writeUInt16BE(statusCode, 2);
  head.writeUInt32BE(1, 4);
  return Buffer.concat([head, Buffer.from([0x01]), body, Buffer.from([0x03])]);
}

test('parseResponse reads the status code and single-valued attributes', () => {
  const buf = response(0x0000, attr(0x44, 'media-default', 'jpn_hagaki_100x148mm'));
  const { statusCode, attributes } = ipp.parseResponse(buf);
  assert.equal(statusCode, 0x0000);
  assert.deepEqual(attributes['media-default'], ['jpn_hagaki_100x148mm']);
});

test('parseResponse collects every value of a multi-valued attribute', () => {
  const buf = response(0x0000, Buffer.concat([
    attr(0x44, 'document-format-supported', 'image/urf'),
    additionalValue(0x44, 'image/jpeg'),
    additionalValue(0x44, 'image/pwg-raster'),
  ]));
  const { attributes } = ipp.parseResponse(buf);
  assert.deepEqual(attributes['document-format-supported'], ['image/urf', 'image/jpeg', 'image/pwg-raster']);
});

test('parseResponse does not confuse a similarly-named attribute for another', () => {
  // The real SELPHY response carries both of these. Scanning the response for
  // the substring "media-ready" would match "media-col-ready" too and could
  // pick paper geometry out of the wrong attribute.
  const buf = response(0x0000, Buffer.concat([
    attr(0x44, 'media-col-ready', 'something-else'),
    attr(0x44, 'media-ready', 'jpn_hagaki_100x148mm'),
  ]));
  const { attributes } = ipp.parseResponse(buf);
  assert.deepEqual(attributes['media-ready'], ['jpn_hagaki_100x148mm']);
  assert.deepEqual(attributes['media-col-ready'], ['something-else']);
});

test('parseResponse rejects a truncated response instead of returning junk', () => {
  assert.throws(() => ipp.parseResponse(Buffer.from([0x02, 0x00])), /too short/);
});

test('isSuccess accepts the whole successful-ok range and nothing above it', () => {
  assert.equal(ipp.isSuccess(0x0000), true);
  assert.equal(ipp.isSuccess(0x0003), true, 'successful-ok-conflicting-attributes still prints');
  assert.equal(ipp.isSuccess(0x0400), false, 'client-error must not read as success');
  assert.equal(ipp.isSuccess(0x0500), false);
});

// ---- capability helpers ----------------------------------------------------

test('acceptsJpeg is true only when image/jpeg is actually offered', () => {
  assert.equal(ipp.acceptsJpeg({ 'document-format-supported': ['image/urf', 'image/jpeg'] }), true);
  assert.equal(ipp.acceptsJpeg({ 'document-format-supported': ['image/urf', 'image/pwg-raster'] }), false);
  assert.equal(ipp.acceptsJpeg({}), false);
});

test('readyMedia prefers the paper currently loaded over the printer default', () => {
  assert.equal(
    ipp.readyMedia({ 'media-ready': ['om_card_54x86mm'], 'media-default': ['jpn_hagaki_100x148mm'] }),
    'om_card_54x86mm',
  );
  assert.equal(ipp.readyMedia({ 'media-default': ['jpn_hagaki_100x148mm'] }), 'jpn_hagaki_100x148mm');
  assert.equal(ipp.readyMedia({}), null);
});

// ---- address parsing -------------------------------------------------------

test('parseTarget accepts the address forms a person might actually type', () => {
  assert.deepEqual(ipp.parseTarget('172.20.10.10'), { host: '172.20.10.10', port: 631, path: '/ipp/print' });
  assert.deepEqual(ipp.parseTarget('ipp://172.20.10.10:631/ipp/print'), { host: '172.20.10.10', port: 631, path: '/ipp/print' });
  assert.deepEqual(ipp.parseTarget('http://printer.local/ipp/print'), { host: 'printer.local', port: 631, path: '/ipp/print' });
  assert.deepEqual(ipp.parseTarget(' 172.20.10.10:9100 '), { host: '172.20.10.10', port: 9100, path: '/ipp/print' });
});

test('parseTarget returns null rather than throwing, so a typo falls back to discovery', () => {
  for (const bad of ['', '   ', null, undefined, 42, 'ipp://']) {
    assert.equal(ipp.parseTarget(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});
