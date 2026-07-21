'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let store;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-store-test-'));
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  // Require after setting env var so the module picks up the override.
  // eslint-disable-next-line global-require
  store = require('../server/store');
});

after(() => {
  delete process.env.PHOTOBOOTH_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset each JSON file between tests for isolation.
  for (const file of ['settings.json', 'frames.json', 'stats.json', 'tokens.json']) {
    const p = path.join(tmpDir, file);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

test('ensureDirs creates data/photos/frames directories', () => {
  store.ensureDirs();
  assert.ok(fs.existsSync(store.DATA_DIR));
  assert.ok(fs.existsSync(store.PHOTOS_DIR));
  assert.ok(fs.existsSync(store.FRAMES_DIR));
});

test('readSettings returns defaults on first read and persists the file', () => {
  const settings = store.readSettings();
  assert.equal(settings.shotsTotal, store.DEFAULT_SETTINGS.shotsTotal);
  assert.ok(fs.existsSync(path.join(tmpDir, 'settings.json')));
});

test('writeSettings merges with defaults and persists', () => {
  const written = store.writeSettings({ shotsTotal: 20 });
  assert.equal(written.shotsTotal, 20);
  assert.equal(written.countdownSeconds, store.DEFAULT_SETTINGS.countdownSeconds);

  const reread = store.readSettings();
  assert.equal(reread.shotsTotal, 20);
});

test('readFrames returns the two default frames (strip + grid) on first read', () => {
  const frames = store.readFrames();
  assert.equal(frames.length, 2);
  assert.ok(frames.some((f) => f.layout === 'strip'));
  assert.ok(frames.some((f) => f.layout === 'grid'));
  assert.ok(frames.every((f) => f.active === true));
});

test('writeFrames persists an updated frame list', () => {
  const frames = store.readFrames();
  const updated = frames.map((f) => ({ ...f, active: false }));
  store.writeFrames(updated);
  const reread = store.readFrames();
  assert.ok(reread.every((f) => f.active === false));
});

test('readStats returns zeroed defaults initially', () => {
  const stats = store.readStats();
  assert.equal(stats.sessionsCompleted, 0);
  assert.equal(stats.sessionsStarted, 0);
});

test('recordSessionStarted increments sessionsStarted and sessionsToday', () => {
  const first = store.recordSessionStarted();
  assert.equal(first.sessionsStarted, 1);
  assert.equal(first.sessionsToday, 1);

  const second = store.recordSessionStarted();
  assert.equal(second.sessionsStarted, 2);
  assert.equal(second.sessionsToday, 2);
});

test('recordSessionCompleted increments completed count and per-frame/filter usage', () => {
  store.recordSessionCompleted({ frameId: 'default-strip', filterId: 'warm' });
  const stats = store.recordSessionCompleted({ frameId: 'default-strip', filterId: 'bw' });
  assert.equal(stats.sessionsCompleted, 2);
  assert.equal(stats.frameUsage['default-strip'], 2);
  assert.equal(stats.filterUsage.warm, 1);
  assert.equal(stats.filterUsage.bw, 1);
});

test('readJsonFile recovers from a corrupt file by backing it up and returning defaults', () => {
  const filePath = path.join(tmpDir, 'settings.json');
  fs.writeFileSync(filePath, '{not valid json');
  const result = store.readJsonFile(filePath, store.DEFAULT_SETTINGS);
  assert.equal(result.shotsTotal, store.DEFAULT_SETTINGS.shotsTotal);
  const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.corrupt-'));
  assert.equal(backups.length, 1);
});
