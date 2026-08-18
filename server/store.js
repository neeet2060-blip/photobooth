'use strict';

const fs = require('fs');
const path = require('path');

// Overridable via PHOTOBOOTH_DATA_DIR so unit tests can run against an
// isolated temp directory instead of the real data/ folder.
const DATA_DIR = process.env.PHOTOBOOTH_DATA_DIR || path.join(__dirname, '..', 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const PRINT_OUTBOX_DIR = path.join(DATA_DIR, 'print-outbox');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const FRAMES_FILE = path.join(DATA_DIR, 'frames.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PRINTJOBS_FILE = path.join(DATA_DIR, 'printjobs.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

const DEFAULT_SETTINGS = {
  shotsTotal: 8,
  countdownSeconds: 3,
  idleTimeoutSec: 180,
  qrTimeoutSec: 90,
  defaultLang: 'ko',
  autoDeleteHours: 24,
  // Lets an event without a physical printer hide the paid print-order flow
  // entirely (see public/control/control.js renderQr) instead of accepting
  // payment for prints nobody can pick up. Defaults to on for future events;
  // this event's actual data/settings.json turns it off.
  printingEnabled: true,
  printUnitPriceCents: 0,
  // Per-quantity prices, keyed by number of prints, in cents — e.g.
  // { "1": 500, "2": 900 }. Takes precedence over printUnitPriceCents when a
  // quantity has an entry.
  //
  // Exists because TOK2026 (which is what actually charges the visitor) prices
  // prints in tiers rather than per unit: 5/9/13/16 EUR for 1-4 prints, where
  // quantity*unitPrice + qrPrice can only ever match one of those. Before this,
  // the booth showed a visitor 8 EUR for two prints and TOK2026 billed 9.
  // Leave empty to keep the old linear behaviour.
  printPriceTiersCents: { '1': 0, '2': 0, '3': 0, '4': 0 },
  maxPrintQuantity: 4,
  // Gates QR delivery itself behind payment, independent of printingEnabled
  // (2026-08-10, TOK2026 photobooth integration — server/tokPayment.js).
  // Defaults OFF: existing/other events must opt in explicitly rather than
  // silently start requiring payment for a QR code that used to be free.
  qrRequiresPayment: false,
  qrUnitPriceCents: 0,
  printMode: 'ipp',
  printerName: 'Canon SELPHY CP1500',
  // Only used by printMode 'ipp' (server/ipp.js). Empty is the normal setting:
  // the venue runs on a phone hotspot that reassigns addresses on every
  // restart, so the printer is discovered on the local subnet instead of being
  // pinned to an address that goes stale. Set it to skip discovery.
  printerUrl: '',
  printMedia: '4x6',
  // How long /api/final waits for the cloud upload before falling back to
  // the LAN-only URL (see server/cloud.js + CLOUD.md).
  cloudUploadTimeoutMs: 8000,
  // Bucket name for cloud delivery (server/cloud.js). The FIREBASE_STORAGE_BUCKET
  // env var, if set, always wins (useful for local dev/testing) — but a shell
  // env var must be re-exported every time the server process is launched,
  // which is easy to forget on event day and fails *silently* into LAN-only
  // mode with no visible error. Persisting the bucket name here instead means
  // setting it once via /admin keeps working across every future restart.
  firebaseStorageBucket: '',
  // DSLR capture (server/camera.js, 2026-08-18) — when true, 'trigger-capture'
  // shells out to gphoto2 against a USB-connected EOS 550D instead of asking
  // the phone-camera browser page (public/camera/camera.js) for a shot.
  // Defaults off: an event that hasn't wired up a DSLR must keep working with
  // the phone camera exactly as before, and a failed gphoto2 capture falls
  // back to the phone-camera path automatically either way (see index.js).
  dslrEnabled: false,
};

const DEFAULT_STATS = {
  sessionsCompleted: 0,
  sessionsToday: 0,
  lastResetDate: null,
  frameUsage: {},
  filterUsage: {},
  sessionsStarted: 0,
};

function ensureDirs() {
  for (const dir of [DATA_DIR, PHOTOS_DIR, FRAMES_DIR, PRINT_OUTBOX_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function readJsonFile(filePath, defaults) {
  ensureDirs();
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, defaults);
    return clone(defaults);
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file: back it up and reset to defaults rather than crash.
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, backupPath);
    } catch (_) {
      /* ignore */
    }
    writeJsonFile(filePath, defaults);
    return clone(defaults);
  }
}

function writeJsonFile(filePath, data) {
  ensureDirs();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultFrames() {
  const now = Date.now();
  return [
    {
      id: 'default-strip',
      name: '기본 스트립',
      layout: 'strip',
      file: '/assets/default-strip.svg',
      active: true,
      order: 0,
      createdAt: now,
    },
    {
      id: 'default-grid',
      name: '기본 그리드',
      layout: 'grid',
      file: '/assets/default-grid.svg',
      active: true,
      order: 1,
      createdAt: now,
    },
  ];
}

function readSettings() {
  const settings = readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
  // Backfill any missing keys added in later versions.
  return { ...DEFAULT_SETTINGS, ...settings };
}

function writeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  writeJsonFile(SETTINGS_FILE, merged);
  return merged;
}

function readFrames() {
  return readJsonFile(FRAMES_FILE, defaultFrames());
}

function writeFrames(frames) {
  writeJsonFile(FRAMES_FILE, frames);
  return frames;
}

function readStats() {
  return { ...clone(DEFAULT_STATS), ...readJsonFile(STATS_FILE, DEFAULT_STATS) };
}

function writeStats(stats) {
  writeJsonFile(STATS_FILE, stats);
  return stats;
}

// Unlike settings/stats, the absence of this file is meaningful: it means
// there is no session to restore.  Do not use readJsonFile here because that
// helper eagerly writes its fallback value when the file is absent.
function readSession() {
  ensureDirs();
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (err) {
    // A corrupt session must not prevent the booth from starting. Keep a
    // timestamped copy for diagnosis, but leave no synthetic empty session.
    try {
      fs.renameSync(SESSION_FILE, `${SESSION_FILE}.corrupt-${Date.now()}`);
    } catch (_) {
      /* ignore */
    }
    return null;
  }
}

function writeSession(sessionState) {
  writeJsonFile(SESSION_FILE, sessionState);
  return sessionState;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function recordSessionStarted() {
  const stats = readStats();
  const today = todayKey();
  const next = {
    ...stats,
    sessionsStarted: (stats.sessionsStarted || 0) + 1,
    sessionsToday: stats.lastResetDate === today ? (stats.sessionsToday || 0) + 1 : 1,
    lastResetDate: today,
  };
  return writeStats(next);
}

function recordSessionCompleted({ frameId, filterId }) {
  const stats = readStats();
  const frameUsage = { ...stats.frameUsage };
  const filterUsage = { ...stats.filterUsage };
  if (frameId) {
    frameUsage[frameId] = (frameUsage[frameId] || 0) + 1;
  }
  if (filterId) {
    filterUsage[filterId] = (filterUsage[filterId] || 0) + 1;
  }
  const next = {
    ...stats,
    sessionsCompleted: (stats.sessionsCompleted || 0) + 1,
    frameUsage,
    filterUsage,
  };
  return writeStats(next);
}

function readPrintJobs() {
  return readJsonFile(PRINTJOBS_FILE, []);
}

function writePrintJobs(jobs) {
  writeJsonFile(PRINTJOBS_FILE, jobs);
  return jobs;
}

module.exports = {
  DATA_DIR,
  PHOTOS_DIR,
  FRAMES_DIR,
  PRINT_OUTBOX_DIR,
  PRINTJOBS_FILE,
  SESSION_FILE,
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  ensureDirs,
  readJsonFile,
  writeJsonFile,
  readSettings,
  writeSettings,
  readFrames,
  writeFrames,
  readStats,
  writeStats,
  readSession,
  writeSession,
  recordSessionStarted,
  recordSessionCompleted,
  defaultFrames,
  readPrintJobs,
  writePrintJobs,
};
