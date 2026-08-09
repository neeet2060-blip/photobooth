'use strict';

/**
 * Cloud delivery adapter: uploads the visitor's final.jpg to a Firebase
 * Storage bucket so the QR code can keep working after the visitor leaves
 * the venue's Wi-Fi/hotspot (mobile data, or opening the link at home).
 * See CLOUD.md for the full rationale, setup steps, and prefix-isolation
 * policy (this bucket is SHARED with another live app).
 *
 * Mirrors printer.js's adapter-isolation style: a small set of exported
 * functions, an injectable seam for tests (_setBucketForTests), and strict
 * input validation so this module can never touch anything outside the
 * `photobooth/` prefix.
 *
 * Must be safe to require with zero credentials present (the default,
 * out-of-the-box state) — every failure path here degrades to
 * isCloudEnabled() === false rather than throwing, so server boot always
 * succeeds regardless of cloud configuration.
 */

const fs = require('fs');
const path = require('path');

// Same shape as server/routes.js's TOKEN_REGEX — duplicated rather than
// imported to avoid a routes.js <-> cloud.js circular dependency (same
// reasoning as the "keep these two definitions in sync" comment in
// printer.js for its printerName/media allowlists).
const TOKEN_REGEX = /^[a-f0-9]{24}$/;

const store = require('./store');

const CREDENTIALS_PATH = process.env.FIREBASE_CREDENTIALS
  || path.join(__dirname, '..', 'secrets', 'firebase-admin.json');

/**
 * Bucket name resolution: the FIREBASE_STORAGE_BUCKET env var always wins
 * when set (useful for local dev/testing without touching settings.json),
 * otherwise falls back to the admin-configurable settings.firebaseStorageBucket
 * — see the comment on that default in server/store.js for why the env var
 * alone is not durable enough for event-day use.
 */
function resolveBucketName() {
  if (process.env.FIREBASE_STORAGE_BUCKET) return process.env.FIREBASE_STORAGE_BUCKET;
  const settings = store.readSettings();
  return settings.firebaseStorageBucket || '';
}

// Every object this module ever touches lives under this prefix. The bucket
// is shared with another, unrelated app — uploadFinalImage/deleteCloudObject
// always build their destination path from PREFIX + a validated token, so
// this module can never list/read/delete anything outside photobooth/.
const PREFIX = 'photobooth';
const SIGNED_URL_EXPIRES_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years out

let cachedBucket = null; // real (lazily-initialized) or injected-for-tests bucket handle
let warnedOnce = false;

function objectName(token) {
  return `${PREFIX}/${token}/final.jpg`;
}

function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  // Only booleans/short messages ever get logged here — never credential
  // paths' contents, key material, or raw SDK error objects that might
  // embed configuration details.
  console.warn(`[cloud] ${message}`);
}

function readCredentialsSafe() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Missing file, unreadable, or malformed JSON: treat as "no
    // credentials" rather than crashing server boot. Cloud delivery is a
    // pure add-on; the booth must work with zero credentials present.
    return null;
  }
}

/**
 * Lazily initializes firebase-admin and returns a Storage bucket handle, or
 * null if cloud delivery isn't configured/available.
 *
 * Only a *successful* handle is cached (module-scope, reused for the process
 * lifetime — firebase-admin apps can't be meaningfully re-initialized with
 * different credentials anyway). A "not configured yet" result is NOT
 * cached: it re-checks readSettings()/readCredentialsSafe() on every call
 * (cheap local file reads, not a hot path — at most once per visitor's final
 * photo) so that setting the bucket name via /admin takes effect on the very
 * next request instead of requiring a server restart.
 */
function getBucket() {
  if (cachedBucket) return cachedBucket;

  const bucketName = resolveBucketName();
  if (!bucketName) {
    warnOnce('disabled — no storage bucket configured (set it in /admin or via FIREBASE_STORAGE_BUCKET).');
    return null;
  }
  const credentials = readCredentialsSafe();
  if (!credentials) {
    warnOnce(`disabled — no valid credentials found at ${CREDENTIALS_PATH}.`);
    return null;
  }

  try {
    // firebase-admin v12+ replaced the old namespaced API
    // (admin.credential.cert, admin.apps, app.storage()) with a modular one.
    // admin.cert/admin.getApps/admin.getApp/admin.initializeApp live on the
    // top-level 'firebase-admin' import; the Storage bucket handle comes
    // from the separate 'firebase-admin/storage' submodule instead of an
    // app.storage() method. Confirmed against the installed v14.2.0 by
    // inspecting Object.keys(require('firebase-admin')) directly — the old
    // API silently returns `undefined` rather than throwing at the call
    // site, which is what made this fail quietly before.
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    // eslint-disable-next-line global-require
    const { getStorage } = require('firebase-admin/storage');
    const app = admin.getApps().length ? admin.getApp() : admin.initializeApp({
      credential: admin.cert(credentials),
      storageBucket: bucketName,
    });
    cachedBucket = getStorage(app).bucket(bucketName);
    return cachedBucket;
  } catch (err) {
    // err.message from firebase-admin is a description of what went wrong
    // (e.g. a malformed key, bad project id) — it never embeds the actual
    // key material, so it's safe to log for diagnosis.
    warnOnce(`disabled — firebase-admin initialization failed: ${(err && err.message) || err}`);
    return null;
  }
}

/**
 * @returns {boolean} true if cloud delivery is configured and ready to use.
 * Safe to call anytime (including with zero credentials present) and cheap
 * enough to call once per request.
 */
function isCloudEnabled() {
  return Boolean(getBucket());
}

/**
 * Test-only seam: inject a fake bucket object (needs .file(name) returning
 * something with .save/.makePublic/.getSignedUrl/.delete) so tests never
 * touch the real firebase-admin SDK or network. Pass null to reset back to
 * the real lazy-init path.
 */
function _setBucketForTests(bucket) {
  cachedBucket = bucket;
}

/**
 * Uploads the local final.jpg to `photobooth/<token>/final.jpg` and returns
 * a public (or long-lived signed) URL.
 *
 * @param {string} localFilePath
 * @param {string} token - must match the app-wide 24-hex-char token shape
 * @returns {Promise<string>}
 */
async function uploadFinalImage(localFilePath, token) {
  if (!TOKEN_REGEX.test(token)) {
    throw new Error('invalid_token');
  }
  const bucket = getBucket();
  if (!bucket) {
    throw new Error('cloud_disabled');
  }

  const destination = objectName(token);
  const file = bucket.file(destination);
  const contents = await fs.promises.readFile(localFilePath);
  await file.save(contents, { metadata: { contentType: 'image/jpeg' } });

  try {
    // Preferred: object-level public ACL, works on buckets without Uniform
    // Bucket-Level Access.
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${destination}`;
  } catch (err) {
    // Uniform Bucket-Level Access buckets reject makePublic() (error message
    // typically mentions "uniform bucket-level access") — fall back to a
    // long-lived signed URL instead of failing the whole upload.
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_EXPIRES_MS,
    });
    return signedUrl;
  }
}

/**
 * Deletes `photobooth/<token>/final.jpg`. No-op resolve if cloud is
 * disabled, or if the object is already gone (idempotent delete) — the
 * retention sweep in server/index.js relies on this so a repeat sweep never
 * errors on an already-cleaned-up object. Other errors reject so the sweep
 * can log + retry on its next pass.
 *
 * @param {string} token
 */
async function deleteCloudObject(token) {
  if (!TOKEN_REGEX.test(token)) {
    throw new Error('invalid_token');
  }
  const bucket = getBucket();
  if (!bucket) {
    return; // cloud disabled: nothing to delete
  }
  const destination = objectName(token);
  try {
    await bucket.file(destination).delete();
  } catch (err) {
    const message = (err && err.message) || '';
    if ((err && err.code === 404) || /not found/i.test(message)) {
      return; // already gone: idempotent success
    }
    throw err;
  }
}

module.exports = {
  isCloudEnabled,
  uploadFinalImage,
  deleteCloudObject,
  _setBucketForTests,
  resolveBucketName,
  CREDENTIALS_PATH,
};
