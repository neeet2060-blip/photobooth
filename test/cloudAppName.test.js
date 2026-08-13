'use strict';

/**
 * Regression guard for the bug that silently disabled cloud delivery for the
 * whole 2026-08 event run: server/cloud.js asked for the DEFAULT firebase app
 * whenever *any* app existed, but server/tokPayment.js registers a named app
 * for a different project. With payment configured — i.e. every real event —
 * getApp() threw and cloud delivery turned itself off with only a console
 * warning, so visitors' QR codes quietly fell back to a LAN URL.
 *
 * Kept out of cloud.test.js because that suite deliberately runs with no
 * credentials at all; this one has to get far enough to touch firebase-admin,
 * which is stubbed through the require cache.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TOK_APP_NAME = 'tok2026';

function withStubbedFirebase(run) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-cloudapp-test-'));
  const credentialsPath = path.join(tmpDir, 'creds.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'k' }));
  fs.writeFileSync(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify({ firebaseStorageBucket: 'test-bucket.firebasestorage.app' }),
  );

  const calls = { initializeApp: [], getApp: 0 };
  // tokPayment's named app is already registered by the time cloud.js runs.
  const apps = [{ name: TOK_APP_NAME }];

  const adminStub = {
    cert: () => ({}),
    getApps: () => apps,
    getApp: () => {
      calls.getApp += 1;
      throw new Error('The default Firebase app does not exist.');
    },
    initializeApp: (options, name) => {
      calls.initializeApp.push({ options, name });
      const app = { name: name || '[DEFAULT]' };
      apps.push(app);
      return app;
    },
  };
  const storageStub = { getStorage: () => ({ bucket: (n) => ({ name: n }) }) };

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function stubbedResolve(request, ...rest) {
    if (request === 'firebase-admin') return 'stub:firebase-admin';
    if (request === 'firebase-admin/storage') return 'stub:firebase-admin/storage';
    return origResolve.call(this, request, ...rest);
  };
  require.cache['stub:firebase-admin'] = { id: 'stub:firebase-admin', filename: 'stub:firebase-admin', loaded: true, exports: adminStub };
  require.cache['stub:firebase-admin/storage'] = { id: 'stub:firebase-admin/storage', filename: 'stub:firebase-admin/storage', loaded: true, exports: storageStub };

  const prevDataDir = process.env.PHOTOBOOTH_DATA_DIR;
  const prevCreds = process.env.FIREBASE_CREDENTIALS;
  const prevBucket = process.env.FIREBASE_STORAGE_BUCKET;
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  process.env.FIREBASE_CREDENTIALS = credentialsPath;
  delete process.env.FIREBASE_STORAGE_BUCKET;

  // Load cloud.js (and its store dependency) fresh so it picks up this env.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}server${path.sep}cloud.js`) || key.includes(`${path.sep}server${path.sep}store.js`)) {
      delete require.cache[key];
    }
  }

  try {
    // eslint-disable-next-line global-require
    const cloud = require('../server/cloud');
    run(cloud, calls);
  } finally {
    Module._resolveFilename = origResolve;
    delete require.cache['stub:firebase-admin'];
    delete require.cache['stub:firebase-admin/storage'];
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}server${path.sep}cloud.js`) || key.includes(`${path.sep}server${path.sep}store.js`)) {
        delete require.cache[key];
      }
    }
    if (prevDataDir === undefined) delete process.env.PHOTOBOOTH_DATA_DIR; else process.env.PHOTOBOOTH_DATA_DIR = prevDataDir;
    if (prevCreds === undefined) delete process.env.FIREBASE_CREDENTIALS; else process.env.FIREBASE_CREDENTIALS = prevCreds;
    if (prevBucket === undefined) delete process.env.FIREBASE_STORAGE_BUCKET; else process.env.FIREBASE_STORAGE_BUCKET = prevBucket;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('cloud delivery still initializes when the payment bridge already registered a named app', () => {
  withStubbedFirebase((cloud, calls) => {
    assert.equal(cloud.isCloudEnabled(), true, 'cloud must not disable itself just because another app exists');
    assert.equal(calls.getApp, 0, 'must never ask for the DEFAULT app — tokPayment owns a different project');
    assert.equal(calls.initializeApp.length, 1);
    assert.equal(
      calls.initializeApp[0].name,
      'photobooth-cloud',
      'cloud must register its own named app so the two projects stay separate',
    );
  });
});
