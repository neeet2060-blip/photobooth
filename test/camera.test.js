'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let store;
let camera;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-camera-test-'));
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  // eslint-disable-next-line global-require
  store = require('../server/store');
  // eslint-disable-next-line global-require
  camera = require('../server/camera');
});

after(() => {
  delete process.env.PHOTOBOOTH_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(store.PHOTOS_DIR)) {
    fs.rmSync(store.PHOTOS_DIR, { recursive: true, force: true });
  }
});

test('captureViaDslr invokes gphoto2 with the expected argv and saves the file at {PHOTOS_DIR}/{sessionId}/{index}.jpg', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    // Simulate gphoto2 writing the downloaded shot to the temp filename it
    // was told to use — the real binary does this itself; the stub has to
    // do it too so the subsequent rename() has something to rename.
    const tmpArg = args[args.indexOf('--filename') + 1];
    fs.writeFileSync(tmpArg, 'fake-jpeg-bytes');
    return { stdout: '', stderr: '' };
  };

  const destPath = await camera.captureViaDslr('session123', 2, { execFileImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gphoto2');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--capture-image-and-download', '--filename']);
  assert.ok(calls[0].args.includes('--force-overwrite'));

  assert.equal(destPath, path.join(store.PHOTOS_DIR, 'session123', '2.jpg'));
  assert.equal(fs.readFileSync(destPath, 'utf8'), 'fake-jpeg-bytes');
  // The temp file must not be left behind after the rename.
  const tmpArgUsed = calls[0].args[calls[0].args.indexOf('--filename') + 1];
  assert.equal(fs.existsSync(tmpArgUsed), false);
});

test('captureViaDslr propagates the gphoto2 error and leaves no partial file at the destination path', async () => {
  const execFileImpl = async () => {
    throw new Error('No camera found');
  };

  await assert.rejects(
    () => camera.captureViaDslr('session456', 0, { execFileImpl }),
    /No camera found/,
  );

  const destPath = path.join(store.PHOTOS_DIR, 'session456', '0.jpg');
  assert.equal(fs.existsSync(destPath), false);
});
