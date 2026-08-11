'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');

const store = require('./store');
const { PHASES, FILTERS } = require('./state');
const { getLanIp } = require('./ip');
const printqueue = require('./printqueue');
const { PRINTER_NAME_REGEX, PRINT_MEDIA_REGEX } = require('./printer');
const cloud = require('./cloud');
const tokPayment = require('./tokPayment');
const { LAYOUTS } = require('./layouts');

const TOKEN_REGEX = /^[a-f0-9]{24}$/;

// Token map lives at module scope (not inside registerRoutes) so that both
// the HTTP routes below and sweepExpiredTokens (called from server/index.js
// on the retention-sweep cadence) read/write the exact same in-memory
// object and the same on-disk file — otherwise the two would drift out of
// sync (routes.js could keep serving a token the sweep already deleted from
// disk, or vice versa).
const TOKENS_FILE = path.join(store.DATA_DIR, 'tokens.json');
let tokens = store.readJsonFile(TOKENS_FILE, {});

function saveTokens() {
  store.writeJsonFile(TOKENS_FILE, tokens);
}

/**
 * Races cloud.uploadFinalImage against a hard timeout so a slow/unreachable
 * cloud backend never blocks the visitor's QR screen — this app is
 * fundamentally LAN-only; cloud delivery is a best-effort layer on top.
 *
 * On timeout (or any upload failure), returns null so the caller falls back
 * to exactly today's LAN-URL behavior. The losing upload promise is given a
 * no-op .catch() so that if it resolves/rejects later (after we've already
 * moved on), it never surfaces as an unhandled rejection.
 *
 * @returns {Promise<string|null>}
 */
function raceCloudUpload(finalPath, token, timeoutMs) {
  const uploadPromise = cloud.uploadFinalImage(finalPath, token);
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  return Promise.race([uploadPromise, timeoutPromise])
    .then((result) => {
      clearTimeout(timer);
      uploadPromise.catch(() => {});
      if (result === null) {
        console.warn(`[cloud] upload timed out after ${timeoutMs}ms for token ${token.slice(0, 8)}…, using LAN URL`);
      }
      return result;
    })
    .catch((err) => {
      clearTimeout(timer);
      uploadPromise.catch(() => {});
      console.warn(`[cloud] upload failed for token ${token.slice(0, 8)}…, using LAN URL: ${err.message}`);
      return null;
    });
}
const FRAME_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_FRAME_MIME = new Set(['image/svg+xml', 'image/png']);

function isValidIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < 10000;
}

function fileFilterFactory(allowedMimes) {
  return (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      cb(new Error('unsupported_file_type'));
      return;
    }
    cb(null, true);
  };
}

/**
 * Registers all HTTP routes on the given Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   getState: () => object,
 *   dispatch: (action: object) => void,
 *   port: number,
 * }} deps
 */
function registerRoutes(app, deps) {
  const { getState, dispatch, port, httpPort } = deps;

  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sessionId = req.body.sessionId;
        if (typeof sessionId !== 'string' || !/^[a-z0-9]{6,40}$/.test(sessionId)) {
          cb(new Error('invalid_session_id'));
          return;
        }
        const dir = path.join(store.PHOTOS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const index = Number(req.body.index);
        if (!isValidIndex(index)) {
          cb(new Error('invalid_index'));
          return;
        }
        cb(null, `${index}.jpg`);
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_PHOTO_MIME),
  });

  const finalUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sessionId = req.body.sessionId;
        if (typeof sessionId !== 'string' || !/^[a-z0-9]{6,40}$/.test(sessionId)) {
          cb(new Error('invalid_session_id'));
          return;
        }
        const dir = path.join(store.PHOTOS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, 'final.jpg'),
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_PHOTO_MIME),
  });

  const printSheetUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sessionId = req.body.sessionId;
        if (typeof sessionId !== 'string' || !/^[a-z0-9]{6,40}$/.test(sessionId)) {
          cb(new Error('invalid_session_id'));
          return;
        }
        const dir = path.join(store.PHOTOS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, 'print.jpg'),
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_PHOTO_MIME),
  });

  const frameUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, store.FRAMES_DIR),
      filename: (req, file, cb) => {
        const ext = file.mimetype === 'image/svg+xml' ? 'svg' : 'png';
        cb(null, `${crypto.randomBytes(8).toString('hex')}.${ext}`);
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_FRAME_MIME),
  });

  // ---- Session photo upload ----

  app.post('/api/photos', photoUpload.single('photo'), (req, res) => {
    const state = getState();
    const sessionId = req.body.sessionId;
    const index = Number(req.body.index);

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    if (state.phase !== PHASES.CAPTURE) {
      return res.status(409).json({ ok: false, error: 'not_in_capture_phase' });
    }
    if (sessionId !== state.sessionId) {
      return res.status(409).json({ ok: false, error: 'session_mismatch' });
    }
    if (!isValidIndex(index) || index >= state.shotsTotal) {
      return res.status(400).json({ ok: false, error: 'invalid_index' });
    }
    if (state.photos.some((p) => p.index === index)) {
      return res.status(409).json({ ok: false, error: 'index_already_used' });
    }

    dispatch({ type: 'photoRecorded', payload: { index, file: `/photos/${sessionId}/${index}.jpg` } });
    return res.json({ ok: true });
  });

  // ---- Final composited image upload ----

  app.post('/api/final', finalUpload.single('photo'), async (req, res) => {
    const state = getState();
    const sessionId = req.body.sessionId;

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    if (state.phase !== PHASES.FILTER) {
      return res.status(409).json({ ok: false, error: 'not_in_filter_phase' });
    }
    if (sessionId !== state.sessionId) {
      return res.status(409).json({ ok: false, error: 'session_mismatch' });
    }

    const token = crypto.randomBytes(12).toString('hex');
    const createdAt = Date.now();

    const lanIp = getLanIp();
    // Visitors reach the download page over plain HTTP: it needs no secure
    // context (no camera/getUserMedia), and HTTPS here would use the LAN
    // self-signed cert, triggering a scary "not private" warning on their
    // phones. This is always the fallback URL — used as-is when cloud
    // delivery is disabled/unreachable/slow, see the cloud-upload attempt
    // below.
    const lanUrl = `http://${lanIp}:${httpPort}/p/${token}`;

    let finalUrl = lanUrl;
    let tokenRecord = { sessionId, createdAt };

    if (cloud.isCloudEnabled()) {
      const settings = store.readSettings();
      const timeoutMs = Number.isFinite(settings.cloudUploadTimeoutMs) && settings.cloudUploadTimeoutMs > 0
        ? settings.cloudUploadTimeoutMs
        : store.DEFAULT_SETTINGS.cloudUploadTimeoutMs;
      const cloudUrl = await raceCloudUpload(req.file.path, token, timeoutMs);
      if (cloudUrl) {
        finalUrl = cloudUrl;
        tokenRecord = { sessionId, createdAt, cloudUrl, uploadedAt: Date.now() };
      }
      // On timeout/failure, cloudUrl is null and we silently keep the LAN
      // fallback already assigned above — raceCloudUpload already logged
      // the reason via console.warn.
    }

    tokens[token] = tokenRecord;
    saveTokens();

    try {
      const qrDataUrl = await QRCode.toDataURL(finalUrl, { margin: 1, width: 480 });
      dispatch({ type: 'finalSaved', payload: { finalUrl, finalToken: token, qrDataUrl } });
      return res.json({ ok: true, finalUrl, token });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'qr_generation_failed', message: err.message });
    }
  });

  // ---- Print-ready sheet upload (paid printing add-on; QR download above is
  // unaffected). This never dispatches a state action — print readiness is
  // independent of the session state machine, it just saves the file. ----

  app.post('/api/print-sheet', printSheetUpload.single('photo'), (req, res) => {
    const state = getState();
    const sessionId = req.body.sessionId;

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    // The client fires this upload right after /api/final succeeds — and
    // /api/final's handler has ALREADY dispatched 'finalSaved' (filter -> qr)
    // by the time its response reaches the client, so by the time this
    // request arrives the session is normally already in qr, not filter.
    // Accept both: sessionId below is the real safety check.
    if (![PHASES.FILTER, PHASES.QR].includes(state.phase)) {
      return res.status(409).json({ ok: false, error: 'not_in_filter_or_qr_phase' });
    }
    if (sessionId !== state.sessionId) {
      return res.status(409).json({ ok: false, error: 'session_mismatch' });
    }

    // Now that print.jpg actually exists on disk, let a pre-paid session
    // (payment happened up front, before capture — see state.js) enqueue
    // its print job. No-op if this session never had a confirmed order.
    dispatch({ type: 'printSheetReady' });

    return res.json({ ok: true });
  });

  // ---- Visitor download page ----

  app.get('/p/:token', (req, res) => {
    const { token } = req.params;
    if (!TOKEN_REGEX.test(token)) {
      return res.status(404).send(renderNotFoundPage());
    }
    const entry = tokens[token];
    if (!entry) {
      return res.status(404).send(renderNotFoundPage());
    }
    const finalPath = path.join(store.PHOTOS_DIR, entry.sessionId, 'final.jpg');
    if (!fs.existsSync(finalPath)) {
      return res.status(404).send(renderNotFoundPage());
    }
    const settings = store.readSettings();
    return res.send(renderDownloadPage({
      imageSrc: `/photos/${entry.sessionId}/final.jpg`,
      autoDeleteHours: settings.autoDeleteHours,
    }));
  });

  // ---- Admin: frames ----

  app.get('/api/admin/frames', (req, res) => {
    res.json({ ok: true, frames: store.readFrames() });
  });

  app.post('/api/admin/frames', frameUpload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : 'Untitled';
    // 2026-08-11: 하드코딩된 strip/grid 삼항연산자 대신 LAYOUTS의 실제 키 목록으로 검증한다 —
    // 인생네컷 10x15cm 전용 grid2a/grid2b가 추가되면서, 새 레이아웃마다 이 파일을 또 고치지
    // 않도록 layouts.js를 단일 진실 공급원으로 삼는다.
    const layout = typeof req.body.layout === 'string' && Object.prototype.hasOwnProperty.call(LAYOUTS, req.body.layout)
      ? req.body.layout
      : null;
    if (!layout) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ ok: false, error: 'invalid_layout' });
    }
    const frames = store.readFrames();
    const id = crypto.randomBytes(6).toString('hex');
    const newFrame = {
      id,
      name,
      layout,
      file: `/frames/${req.file.filename}`,
      active: true,
      order: frames.length,
      createdAt: Date.now(),
    };
    const next = store.writeFrames([...frames, newFrame]);
    res.json({ ok: true, frames: next });
  });

  app.post('/api/admin/frames/:id', (req, res) => {
    const { id } = req.params;
    if (!FRAME_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const frames = store.readFrames();
    const idx = frames.findIndex((f) => f.id === id);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const patch = {};
    if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 80);
    if (typeof req.body.active === 'boolean') patch.active = req.body.active;
    if (req.body.move === 'up' || req.body.move === 'down') {
      const sorted = [...frames].sort((a, b) => a.order - b.order);
      const pos = sorted.findIndex((f) => f.id === id);
      const swapWith = req.body.move === 'up' ? pos - 1 : pos + 1;
      if (swapWith >= 0 && swapWith < sorted.length) {
        const a = sorted[pos];
        const b = sorted[swapWith];
        const orderA = a.order;
        sorted[pos] = { ...a, order: b.order };
        sorted[swapWith] = { ...b, order: orderA };
      }
      const next = store.writeFrames(sorted);
      return res.json({ ok: true, frames: next });
    }
    const next = [...frames];
    next[idx] = { ...next[idx], ...patch };
    const written = store.writeFrames(next);
    return res.json({ ok: true, frames: written });
  });

  app.delete('/api/admin/frames/:id', (req, res) => {
    const { id } = req.params;
    if (!FRAME_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const frames = store.readFrames();
    const frame = frames.find((f) => f.id === id);
    if (!frame) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const next = frames.filter((f) => f.id !== id);
    store.writeFrames(next);
    if (frame.file && frame.file.startsWith('/frames/')) {
      const filePath = path.join(store.FRAMES_DIR, path.basename(frame.file));
      fs.unlink(filePath, () => {});
    }
    res.json({ ok: true, frames: next });
  });

  // ---- Admin: settings ----

  app.get('/api/admin/settings', (req, res) => {
    res.json({ ok: true, settings: store.readSettings() });
  });

  app.post('/api/admin/settings', (req, res) => {
    const body = req.body || {};
    const current = store.readSettings();
    const next = { ...current };

    const numericFields = [
      'shotsTotal', 'countdownSeconds', 'idleTimeoutSec', 'qrTimeoutSec', 'autoDeleteHours', 'cloudUploadTimeoutMs',
    ];
    for (const field of numericFields) {
      if (body[field] !== undefined) {
        const num = Number(body[field]);
        if (!Number.isFinite(num) || num <= 0) {
          return res.status(400).json({ ok: false, error: `invalid_${field}` });
        }
        next[field] = Math.round(num);
      }
    }
    // cloudUploadTimeoutMs additionally has an upper bound (unlike the other
    // numericFields above): it gates how long a visitor's QR screen can be
    // blocked waiting on the cloud upload, so an accidental huge value here
    // must not be allowed to silently make every session feel frozen.
    // Follows the same "separate if block, own error code" shape as
    // printUnitPriceCents/maxPrintQuantity below rather than special-casing
    // the generic loop above.
    if (body.cloudUploadTimeoutMs !== undefined && next.cloudUploadTimeoutMs > 60000) {
      return res.status(400).json({ ok: false, error: 'invalid_cloudUploadTimeoutMs_range' });
    }
    if (body.defaultLang !== undefined) {
      if (body.defaultLang !== 'ko' && body.defaultLang !== 'en') {
        return res.status(400).json({ ok: false, error: 'invalid_defaultLang' });
      }
      next.defaultLang = body.defaultLang;
    }

    if (body.firebaseStorageBucket !== undefined) {
      // Practical GCS bucket-name allowlist: lowercase letters, digits,
      // dots, dashes, underscores. Empty string is valid (means "cloud
      // delivery off unless FIREBASE_STORAGE_BUCKET env var is set").
      if (body.firebaseStorageBucket !== '' && !/^[a-z0-9][a-z0-9._-]{1,253}$/.test(body.firebaseStorageBucket)) {
        return res.status(400).json({ ok: false, error: 'invalid_firebaseStorageBucket' });
      }
      next.firebaseStorageBucket = body.firebaseStorageBucket;
    }
    if (body.printingEnabled !== undefined) {
      if (typeof body.printingEnabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'invalid_printingEnabled' });
      }
      next.printingEnabled = body.printingEnabled;
    }
    if (body.printUnitPriceCents !== undefined) {
      const num = Number(body.printUnitPriceCents);
      if (!Number.isInteger(num) || num <= 0 || num > 100000) {
        return res.status(400).json({ ok: false, error: 'invalid_printUnitPriceCents' });
      }
      next.printUnitPriceCents = num;
    }
    if (body.maxPrintQuantity !== undefined) {
      const num = Number(body.maxPrintQuantity);
      if (!Number.isInteger(num) || num < 1 || num > 99) {
        return res.status(400).json({ ok: false, error: 'invalid_maxPrintQuantity' });
      }
      next.maxPrintQuantity = num;
    }
    if (body.qrRequiresPayment !== undefined) {
      if (typeof body.qrRequiresPayment !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'invalid_qrRequiresPayment' });
      }
      next.qrRequiresPayment = body.qrRequiresPayment;
    }
    if (body.qrUnitPriceCents !== undefined) {
      const num = Number(body.qrUnitPriceCents);
      if (!Number.isInteger(num) || num < 0 || num > 100000) {
        return res.status(400).json({ ok: false, error: 'invalid_qrUnitPriceCents' });
      }
      next.qrUnitPriceCents = num;
    }
    if (body.printMode !== undefined) {
      if (body.printMode !== 'folder' && body.printMode !== 'cups') {
        return res.status(400).json({ ok: false, error: 'invalid_printMode' });
      }
      next.printMode = body.printMode;
    }
    if (body.printerName !== undefined) {
      if (body.printerName !== '' && !PRINTER_NAME_REGEX.test(body.printerName)) {
        return res.status(400).json({ ok: false, error: 'invalid_printerName' });
      }
      next.printerName = body.printerName;
    }
    if (body.printMedia !== undefined) {
      if (!PRINT_MEDIA_REGEX.test(body.printMedia)) {
        return res.status(400).json({ ok: false, error: 'invalid_printMedia' });
      }
      next.printMedia = body.printMedia;
    }

    const written = store.writeSettings(next);
    res.json({ ok: true, settings: written });
  });

  // ---- Admin: cloud delivery status (read-only) ----
  //
  // Never include credential paths, key contents, or any other secret value
  // here — this is purely operational visibility (is it on, what bucket,
  // how many photos went out each way).
  app.get('/api/admin/cloud', (req, res) => {
    const settings = store.readSettings();
    const enabled = cloud.isCloudEnabled();
    const tokensSnapshot = store.readJsonFile(TOKENS_FILE, {});
    let cloudDeliveredCount = 0;
    let lanFallbackCount = 0;
    for (const entry of Object.values(tokensSnapshot)) {
      if (entry && entry.cloudUrl) {
        cloudDeliveredCount += 1;
      } else {
        lanFallbackCount += 1;
      }
    }
    res.json({
      ok: true,
      enabled,
      bucket: enabled ? cloud.resolveBucketName() : null,
      uploadTimeoutMs: settings.cloudUploadTimeoutMs,
      cloudDeliveredCount,
      lanFallbackCount,
    });
  });

  // ---- Admin: stats ----

  app.get('/api/admin/stats', (req, res) => {
    const stats = store.readStats();
    const completionRate = stats.sessionsStarted > 0
      ? Math.round((stats.sessionsCompleted / stats.sessionsStarted) * 1000) / 10
      : 0;
    res.json({ ok: true, stats: { ...stats, completionRate } });
  });

  // ---- Admin: print queue ----

  const PRINT_JOB_ID_REGEX = /^[a-z0-9]{1,40}$/;

  app.get('/api/admin/printqueue', (req, res) => {
    res.json({ ok: true, jobs: printqueue.getQueueSnapshot() });
  });

  app.post('/api/admin/printqueue/:id/retry', (req, res) => {
    const { id } = req.params;
    if (!PRINT_JOB_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const job = printqueue.retryJob(id);
    if (!job) {
      return res.status(409).json({ ok: false, error: 'not_retryable' });
    }
    return res.json({ ok: true, job });
  });

  app.post('/api/admin/printqueue/:id/cancel', (req, res) => {
    const { id } = req.params;
    if (!PRINT_JOB_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const job = printqueue.cancelJob(id);
    if (!job) {
      return res.status(409).json({ ok: false, error: 'not_cancelable' });
    }
    return res.json({ ok: true, job });
  });

  // ---- Admin: print revenue settlement ----
  //
  // Payment is confirmed out-of-band (staff, physical SumUp terminal) BEFORE
  // a print job is ever created — the job's existence is the proof of
  // payment. A failed print is an operational/printer problem, not a
  // refund, so it still counts as revenue. Only 'canceled' jobs (which can
  // only happen while still 'queued', i.e. never printed) are excluded.
  app.get('/api/admin/printsettlement', (req, res) => {
    const jobs = printqueue.getQueueSnapshot().filter((j) => j.status !== 'canceled');

    let totalPrintsSold = 0;
    let totalRevenueCents = 0;
    const byDay = {};
    const byHour = {};

    for (const job of jobs) {
      totalPrintsSold += job.quantity;
      totalRevenueCents += job.totalCents;

      const date = new Date(job.createdAt);
      const dayKey = date.toISOString().slice(0, 10);
      const hourKey = date.getHours();

      byDay[dayKey] = byDay[dayKey] || { quantity: 0, revenueCents: 0 };
      byDay[dayKey].quantity += job.quantity;
      byDay[dayKey].revenueCents += job.totalCents;

      byHour[hourKey] = byHour[hourKey] || { quantity: 0, revenueCents: 0 };
      byHour[hourKey].quantity += job.quantity;
      byHour[hourKey].revenueCents += job.totalCents;
    }

    const orders = [...jobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        id: j.id,
        createdAt: j.createdAt,
        sessionId: j.sessionId,
        quantity: j.quantity,
        totalCents: j.totalCents,
        status: j.status,
      }));

    res.json({
      ok: true,
      totalPrintsSold,
      totalRevenueCents,
      byDay,
      byHour,
      orders,
    });
  });

  // ---- Misc metadata for clients ----

  app.get('/api/frames', (req, res) => {
    const frames = store
      .readFrames()
      .filter((f) => f.active)
      .sort((a, b) => a.order - b.order);
    res.json({ ok: true, frames });
  });

  app.get('/api/filters', (req, res) => {
    res.json({ ok: true, filters: FILTERS });
  });

  app.get('/api/lan-info', (req, res) => {
    res.json({ ok: true, ip: getLanIp(), port });
  });

  // Fetched by control.js's payment-confirm handler to decide whether an
  // auto-confirm is coming (TOK2026 bridge active — wait silently) or not
  // (bridge unconfigured this event — fall back to the pre-integration
  // behavior of confirming immediately). Card payments themselves are opened
  // from TOK2026's own exp1 admin screen on the actual phone terminal (see
  // ExpPosPage.jsx's payCardForPendingOrder) — this tablet never opens a
  // SumUp deep link, since Tap to Pay isn't supported on tablets.
  app.get('/api/tok-payment-status', (req, res) => {
    res.json({ ok: true, enabled: tokPayment.isEnabled() });
  });

  // ---- Role pages: serve each role's index.html directly on the bare path ----
  // (without this, express.static would 301-redirect e.g. GET /control to
  // GET /control/ before serving the file, which breaks simple health checks
  // and is an unnecessary round trip for every client.)

  const ROLE_PAGES = ['control', 'camera', 'remote', 'display', 'admin'];
  for (const role of ROLE_PAGES) {
    app.get(`/${role}`, (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', role, 'index.html'));
    });
  }

  // ---- Home page: role links + QR codes ----

  app.get('/', async (req, res) => {
    const lanIp = getLanIp();
    const roles = [
      { path: '/control', label: '컨트롤 (태블릿)' },
      { path: '/camera', label: '카메라 (스마트폰)' },
      { path: '/remote', label: '리모컨' },
      { path: '/display', label: '디스플레이 (TV)' },
      { path: '/admin', label: '관리자' },
    ];

    try {
      const withQr = await Promise.all(
        roles.map(async (role) => {
          const url = `https://${lanIp}:${port}${role.path}`;
          const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
          return { ...role, url, qrDataUrl };
        }),
      );
      res.send(renderHomePage({ lanIp, port, roles: withQr }));
    } catch (err) {
      res.status(500).send('QR generation failed');
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHomePage({ lanIp, port, roles }) {
  const cards = roles
    .map(
      (role) => `
      <a class="role-card" href="${escapeHtml(role.url)}">
        <img src="${role.qrDataUrl}" alt="${escapeHtml(role.label)} QR" />
        <div class="role-label">${escapeHtml(role.label)}</div>
        <div class="role-url">${escapeHtml(role.url)}</div>
      </a>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>인생네컷 포토부스 - 설정</title>
  <link rel="stylesheet" href="/shared/app.css" />
  <style>
    .home { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
    .lan-banner { text-align: center; font-size: 1.4rem; margin-bottom: 24px; padding: 16px; border: 2px solid var(--accent); border-radius: 12px; }
    .roles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .role-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--surface); border-radius: 16px; text-decoration: none; color: inherit; }
    .role-card img { width: 160px; height: 160px; background: #fff; border-radius: 8px; }
    .role-label { font-weight: bold; font-size: 1.1rem; }
    .role-url { font-size: 0.8rem; opacity: 0.7; word-break: break-all; text-align: center; }
  </style>
</head>
<body>
  <div class="home">
    <h1>인생네컷 포토부스</h1>
    <div class="lan-banner">서버 주소: <strong>${escapeHtml(lanIp)}:${port}</strong></div>
    <div class="roles-grid">${cards}</div>
  </div>
</body>
</html>`;
}

function renderDownloadPage({ imageSrc, autoDeleteHours }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>내 사진 - 인생네컷</title>
  <link rel="stylesheet" href="/shared/app.css" />
  <style>
    .download-page { max-width: 480px; margin: 0 auto; padding: 24px 16px; text-align: center; }
    .download-page img { width: 100%; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); margin-bottom: 20px; -webkit-touch-callout: default; }
    .save-btn { display: inline-block; width: 100%; box-sizing: border-box; padding: 18px 24px; font-size: 1.25rem; font-weight: bold; background: var(--accent); color: #111; border: none; border-radius: 999px; text-decoration: none; cursor: pointer; }
    .hint { margin-top: 16px; font-size: 0.95rem; line-height: 1.5; opacity: 0.85; }
    .hint .en { display: block; font-size: 0.85rem; opacity: 0.7; margin-top: 4px; }
    .privacy-note { margin-top: 22px; font-size: 0.8rem; opacity: 0.6; line-height: 1.4; }
    .toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: #fff; padding: 12px 20px; border-radius: 999px; font-size: 0.9rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="download-page">
    <h1>내 사진 📸</h1>
    <img id="photo" src="${escapeHtml(imageSrc)}" alt="최종 사진" />
    <button id="save-btn" class="save-btn">사진 저장 / Save</button>
    <p class="hint" id="hint">
      아이폰: 사진을 <b>길게 눌러</b> "사진에 추가"
      <span class="en">iPhone: press &amp; hold the photo → "Add to Photos"</span>
    </p>
    <p class="privacy-note">이 사진은 ${Number(autoDeleteHours)}시간 후 자동 삭제됩니다.<br/>This photo is auto-deleted after ${Number(autoDeleteHours)} hours.</p>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    (function () {
      var imageSrc = ${JSON.stringify(imageSrc)};
      var btn = document.getElementById('save-btn');
      var toastEl = document.getElementById('toast');
      function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        setTimeout(function () { toastEl.classList.remove('show'); }, 2500);
      }
      async function fetchFile() {
        var res = await fetch(imageSrc);
        var blob = await res.blob();
        return new File([blob], 'taste-of-korea.jpg', { type: 'image/jpeg' });
      }
      btn.addEventListener('click', async function () {
        // Preferred path: native share sheet (iOS → "이미지 저장" into Photos).
        try {
          var file = await fetchFile();
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user closed the sheet
        }
        // Fallback: trigger a download (works on Android / desktop).
        try {
          var a = document.createElement('a');
          a.href = imageSrc;
          a.download = 'taste-of-korea.jpg';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast('저장을 시작했어요 / Saving…');
        } catch (e) {
          toast('사진을 길게 눌러 저장하세요 / Long-press the photo');
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>사진을 찾을 수 없습니다</title>
  <link rel="stylesheet" href="/shared/app.css" />
</head>
<body>
  <div style="max-width:480px;margin:80px auto;text-align:center;padding:16px;">
    <h1>404</h1>
    <p>사진을 찾을 수 없거나 만료되었습니다.</p>
  </div>
</body>
</html>`;
}

/**
 * Retention sweep for token records that have a cloud copy. Called by
 * server/index.js on the same AUTO_DELETE_SWEEP_INTERVAL_MS cadence as
 * sweepOldPhotos/sweepOldPrintFiles.
 *
 * Tokens are otherwise routes.js's own domain (the module-scope `tokens`
 * object above + tokens.json), so rather than exposing that live object
 * across module boundaries, index.js just calls this one exported function
 * and lets routes.js keep full control of reading/writing its own file —
 * this mirrors how printqueue.js owns printjobs.json end-to-end and only
 * exposes narrow functions (enqueueJob, retryJob, ...) to the rest of the app.
 *
 * Only entries with a `cloudUrl` are considered (LAN-only tokens have no
 * cloud object to delete, so they're left as-is here). A cloud-delete
 * failure (network blip, transient API error) leaves that entry untouched
 * so it's retried on the next sweep 10 minutes later, and never throws out
 * of this function (a stuck sweep must never crash the interval in index.js).
 *
 * @param {{ autoDeleteHours: number }} settings
 */
async function sweepExpiredTokens(settings) {
  const maxAgeMs = settings.autoDeleteHours * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;

  for (const [token, entry] of Object.entries(tokens)) {
    if (!entry || !entry.cloudUrl) continue;
    if (now - entry.createdAt <= maxAgeMs) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await cloud.deleteCloudObject(token);
      delete tokens[token];
      changed = true;
    } catch (err) {
      console.warn(`[cloud] failed to delete expired cloud object for token ${token.slice(0, 8)}…, will retry next sweep: ${err.message}`);
    }
  }

  if (changed) {
    saveTokens();
  }
}

module.exports = {
  registerRoutes,
  sweepExpiredTokens,
  // Test-only seam: lets test/cloud.test.js exercise the timeout/fallback
  // race in isolation, without spinning up a full HTTP + multer round trip.
  _raceCloudUpload: raceCloudUpload,
};
