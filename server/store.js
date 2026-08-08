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
  printUnitPriceCents: 300,
  maxPrintQuantity: 10,
  printMode: 'folder',
  printerName: '',
  printMedia: '4x6',
  // How long /api/final waits for the cloud upload before falling back to
  // the LAN-only URL (see server/cloud.js + CLOUD.md).
  cloudUploadTimeoutMs: 8000,
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
  recordSessionStarted,
  recordSessionCompleted,
  defaultFrames,
  readPrintJobs,
  writePrintJobs,
};
