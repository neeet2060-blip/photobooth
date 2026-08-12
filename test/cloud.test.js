'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let tmpDir;
let store;
let cloud;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-cloud-test-'));
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  // No FIREBASE_CREDENTIALS/FIREBASE_STORAGE_BUCKET set anywhere in this
  // suite: cloud.js must default to fully disabled, matching the real
  // out-of-the-box repo state (no secrets/firebase-admin.json committed).
  // eslint-disable-next-line global-require
  store = require('../server/store');
  // eslint-disable-next-line global-require
  cloud = require('../server/cloud');
});

after(() => {
  delete process.env.PHOTOBOOTH_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const relPath of ['tokens.json', 'settings.json']) {
    const p = path.join(tmpDir, relPath);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  // Reset cloud.js's lazy-init cache between tests so each test controls
  // whether cloud is "enabled" via the injectable bucket seam.
  cloud._setBucketForTests(null);
});

function makeFakeBucket({ makePublicShouldThrow = false } = {}) {
  const savedFiles = {};
  const deletedNames = [];
  const bucket = {
    name: 'fake-bucket',
    file(name) {
      return {
        name,
        async save(contents) {
          savedFiles[name] = contents;
        },
        async makePublic() {
          if (makePublicShouldThrow) {
            throw new Error('uniform bucket-level access is enabled for this bucket');
          }
        },
        async getSignedUrl() {
          return [`https://signed.example.com/${name}?exp=far-future`];
        },
        async delete() {
          if (!(name in savedFiles) && !deletedNames.includes(name)) {
            const err = new Error('No such object');
            err.code = 404;
            throw err;
          }
          deletedNames.push(name);
          delete savedFiles[name];
        },
      };
    },
  };
  return { bucket, savedFiles, deletedNames };
}

// ---- isCloudEnabled() ----

test('isCloudEnabled() is false with no credentials/bucket configured (default repo state)', () => {
  assert.equal(cloud.isCloudEnabled(), false);
});

test('isCloudEnabled() is true once a bucket is injected for tests', () => {
  const { bucket } = makeFakeBucket();
  cloud._setBucketForTests(bucket);
  assert.equal(cloud.isCloudEnabled(), true);
});

// ---- uploadFinalImage ----

test('uploadFinalImage rejects an invalid (non-24-hex) token even when cloud is enabled', async () => {
  const { bucket } = makeFakeBucket();
  cloud._setBucketForTests(bucket);
  const src = path.join(tmpDir, 'final-invalid-token.jpg');
  fs.writeFileSync(src, 'fake-jpeg-bytes');

  await assert.rejects(() => cloud.uploadFinalImage(src, 'not-a-valid-token'));
});

test('uploadFinalImage rejects with cloud_disabled when no bucket is configured', async () => {
  const src = path.join(tmpDir, 'final-disabled.jpg');
  fs.writeFileSync(src, 'fake-jpeg-bytes');
  const token = 'a'.repeat(24);

  await assert.rejects(() => cloud.uploadFinalImage(src, token), /cloud_disabled/);
});

test('uploadFinalImage uploads to photobooth/<token>/final.jpg and returns a public URL via makePublic', async () => {
  const { bucket, savedFiles } = makeFakeBucket({ makePublicShouldThrow: false });
  cloud._setBucketForTests(bucket);
  const src = path.join(tmpDir, 'final-public.jpg');
  fs.writeFileSync(src, 'fake-jpeg-bytes');
  const token = 'b'.repeat(24);

  const url = await cloud.uploadFinalImage(src, token);

  const expectedDestination = `photobooth/${token}/final.jpg`;
  assert.ok(expectedDestination in savedFiles, 'file must be saved under the photobooth/ prefix');
  assert.ok(url.startsWith('https://storage.googleapis.com/'));
  assert.ok(url.includes(expectedDestination));
});

test('uploadFinalImage falls back to a signed URL when makePublic throws (uniform bucket-level access)', async () => {
  const { bucket, savedFiles } = makeFakeBucket({ makePublicShouldThrow: true });
  cloud._setBucketForTests(bucket);
  const src = path.join(tmpDir, 'final-signed.jpg');
  fs.writeFileSync(src, 'fake-jpeg-bytes');
  const token = 'c'.repeat(24);

  const url = await cloud.uploadFinalImage(src, token);

  const expectedDestination = `photobooth/${token}/final.jpg`;
  assert.ok(expectedDestination in savedFiles);
  assert.ok(url.startsWith('https://signed.example.com/'));
});

// ---- deleteCloudObject ----

test('deleteCloudObject rejects an invalid token', async () => {
  await assert.rejects(() => cloud.deleteCloudObject('short'));
});

test('deleteCloudObject is a no-op when cloud is disabled', async () => {
  const token = 'd'.repeat(24);
  await assert.doesNotReject(() => cloud.deleteCloudObject(token));
});

test('deleteCloudObject is idempotent: deleting an already-gone object resolves instead of rejecting', async () => {
  const { bucket } = makeFakeBucket();
  cloud._setBucketForTests(bucket);
  const token = 'e'.repeat(24);
  // Never uploaded, so the fake bucket's delete() throws a 404-shaped error.
  await assert.doesNotReject(() => cloud.deleteCloudObject(token));
});

test('deleteCloudObject deletes an uploaded object and only ever touches the photobooth/ prefix', async () => {
  const { bucket, savedFiles, deletedNames } = makeFakeBucket();
  cloud._setBucketForTests(bucket);
  const src = path.join(tmpDir, 'final-delete.jpg');
  fs.writeFileSync(src, 'fake-jpeg-bytes');
  const token = 'f'.repeat(24);

  await cloud.uploadFinalImage(src, token);
  await cloud.deleteCloudObject(token);

  assert.deepEqual(deletedNames, [`photobooth/${token}/final.jpg`]);
  assert.ok(!(`photobooth/${token}/final.jpg` in savedFiles));
});

test('deleteCloudObject rejects on non-404 errors so the retention sweep can retry', async () => {
  const bucket = {
    name: 'fake-bucket',
    file() {
      return {
        async delete() {
          throw new Error('permission denied');
        },
      };
    },
  };
  cloud._setBucketForTests(bucket);
  const token = 'a1a1a1a1a1a1a1a1a1a1a1a1';
  await assert.rejects(() => cloud.deleteCloudObject(token), /permission denied/);
});

// ---- routes.js wiring: raceCloudUpload timeout/fallback + settings validation ----

let routes;
let cloudModule;

function freshRoutes() {
  delete require.cache[require.resolve('../server/routes')];
  // eslint-disable-next-line global-require
  routes = require('../server/routes');
  // eslint-disable-next-line global-require
  cloudModule = require('../server/cloud');
  return routes;
}

test('raceCloudUpload returns the cloud URL when the upload resolves before the timeout', async () => {
  freshRoutes();
  const originalUpload = cloudModule.uploadFinalImage;
  cloudModule.uploadFinalImage = async () => 'https://cloud.example.com/photobooth/x/final.jpg';
  try {
    const result = await routes._raceCloudUpload('/tmp/whatever.jpg', 'a'.repeat(24), 200);
    assert.equal(result, 'https://cloud.example.com/photobooth/x/final.jpg');
  } finally {
    cloudModule.uploadFinalImage = originalUpload;
  }
});

test('raceCloudUpload falls back to null (LAN URL) when the upload never resolves before the timeout', async () => {
  freshRoutes();
  const originalUpload = cloudModule.uploadFinalImage;
  let neverResolvedRejectLater;
  cloudModule.uploadFinalImage = () => new Promise((resolve, reject) => {
    // Deliberately never resolves within the test — simulates a hung
    // network call. Resolve much later so we can also verify the late
    // settle doesn't crash anything (see the "never crashes" assertion below).
    neverResolvedRejectLater = () => reject(new Error('too late, nobody is listening'));
  });

  try {
    const start = Date.now();
    const result = await routes._raceCloudUpload('/tmp/whatever.jpg', 'b'.repeat(24), 50);
    const elapsedMs = Date.now() - start;
    assert.equal(result, null, 'timeout must resolve to null so the caller falls back to the LAN URL');
    assert.ok(elapsedMs < 1000, 'must not wait for the real upload to ever settle');
  } finally {
    // Fire the late rejection now; if this were unhandled it would surface
    // as an "UnhandledPromiseRejection" warning/crash under node:test.
    if (neverResolvedRejectLater) neverResolvedRejectLater();
    cloudModule.uploadFinalImage = originalUpload;
  }
});

test('raceCloudUpload returns null when the upload rejects', async () => {
  freshRoutes();
  const originalUpload = cloudModule.uploadFinalImage;
  cloudModule.uploadFinalImage = async () => {
    throw new Error('upload service unavailable');
  };
  try {
    const result = await routes._raceCloudUpload('/tmp/whatever.jpg', 'c'.repeat(24), 200);
    assert.equal(result, null);
  } finally {
    cloudModule.uploadFinalImage = originalUpload;
  }
});

// ---- sweepExpiredTokens ----

test('sweepExpiredTokens deletes only expired cloud-delivered tokens and prunes them from disk', async () => {
  const now = Date.now();
  const tokensPath = path.join(tmpDir, 'tokens.json');
  const expiredCloudToken = 'a'.repeat(24);
  const freshCloudToken = 'b'.repeat(24);
  const expiredLanOnlyToken = 'c'.repeat(24);
  fs.writeFileSync(tokensPath, JSON.stringify({
    [expiredCloudToken]: {
      sessionId: 's1', createdAt: now - 100 * 60 * 60 * 1000, cloudUrl: 'https://cloud.example.com/x', uploadedAt: now,
    },
    [freshCloudToken]: {
      sessionId: 's2', createdAt: now, cloudUrl: 'https://cloud.example.com/y', uploadedAt: now,
    },
    [expiredLanOnlyToken]: {
      sessionId: 's3', createdAt: now - 100 * 60 * 60 * 1000,
    },
  }));

  freshRoutes();
  const deleteCalls = [];
  cloudModule.deleteCloudObject = async (token) => {
    deleteCalls.push(token);
  };

  await routes.sweepExpiredTokens({ autoDeleteHours: 24 });

  // Only the expired *cloud* token should have triggered a delete call, and
  // it must be called with a bare token (cloud.js itself is responsible for
  // building the photobooth/-prefixed destination from it).
  assert.deepEqual(deleteCalls, [expiredCloudToken]);

  const written = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  assert.ok(!(expiredCloudToken in written), 'expired cloud token must be pruned');
  assert.ok(freshCloudToken in written, 'non-expired cloud token must be kept');
  assert.ok(expiredLanOnlyToken in written, 'expired LAN-only token (no cloudUrl) is left alone by this sweep');
});

test('sweepExpiredTokens keeps the token entry (for retry) when cloud deletion fails, and never throws', async () => {
  const now = Date.now();
  const tokensPath = path.join(tmpDir, 'tokens.json');
  const expiredCloudToken = 'd'.repeat(24);
  fs.writeFileSync(tokensPath, JSON.stringify({
    [expiredCloudToken]: {
      sessionId: 's1', createdAt: now - 100 * 60 * 60 * 1000, cloudUrl: 'https://cloud.example.com/x', uploadedAt: now,
    },
  }));

  freshRoutes();
  cloudModule.deleteCloudObject = async () => {
    throw new Error('transient network error');
  };

  await assert.doesNotReject(() => routes.sweepExpiredTokens({ autoDeleteHours: 24 }));

  const written = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  assert.ok(expiredCloudToken in written, 'token must be retried on the next sweep, not dropped on failure');
});

// ---- POST /api/admin/settings: cloudUploadTimeoutMs validation ----

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function stopTestServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withTestApp(fn) {
  freshRoutes();
  const express = require('express'); // eslint-disable-line global-require
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const state = { phase: 'idle', sessionId: null };
  routes.registerRoutes(app, {
    getState: () => state,
    dispatch: () => {},
    port: 3000,
    httpPort: 3001,
  });
  const server = await startTestServer(app);
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await stopTestServer(server);
  }
}

test('POST /api/admin/settings accepts a valid cloudUploadTimeoutMs', async () => {
  await withTestApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUploadTimeoutMs: 5000 }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.settings.cloudUploadTimeoutMs, 5000);
  });
});

for (const badValue of [0, -100, 'not-a-number']) {
  test(`POST /api/admin/settings rejects invalid cloudUploadTimeoutMs: ${JSON.stringify(badValue)}`, async () => {
    await withTestApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudUploadTimeoutMs: badValue }),
      });
      assert.equal(res.status, 400);
    });
  });
}

test('POST /api/admin/settings rejects a cloudUploadTimeoutMs above the 60000ms upper bound', async () => {
  await withTestApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudUploadTimeoutMs: 999999 }),
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error, 'invalid_cloudUploadTimeoutMs_range');
  });
});

test('GET /api/admin/cloud reports disabled status and zero counts with no credentials configured', async () => {
  await withTestApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/cloud`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.enabled, false);
    assert.equal(data.bucket, null);
    assert.ok(typeof data.uploadTimeoutMs === 'number');
  });
});
