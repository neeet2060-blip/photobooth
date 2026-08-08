'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

const store = require('./store');
const { getOrCreateCerts } = require('./certs');
const { getLanIp } = require('./ip');
const { registerRoutes, sweepExpiredTokens } = require('./routes');
const stateMachine = require('./state');
const printqueue = require('./printqueue');

const HTTPS_PORT = Number(process.env.PORT) || 3000;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3001;
const IDLE_SWEEP_INTERVAL_MS = 5000;
const AUTO_DELETE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

store.ensureDirs();

// ---- Global session state (single booth, single active session) ----

let sessionState = stateMachine.createInitialState();

function getState() {
  return sessionState;
}

function getContext() {
  return { settings: store.readSettings(), frames: store.readFrames() };
}

function dispatch(action) {
  const { state: nextState, effects } = stateMachine.applyAction(sessionState, action, getContext());
  sessionState = nextState;
  broadcastState();
  for (const effect of effects) {
    runEffect(effect);
  }
}

function runEffect(effect) {
  switch (effect.type) {
    case 'session-started':
      store.recordSessionStarted();
      break;
    case 'session-abandoned':
      deleteSessionPhotos(effect.sessionId);
      break;
    case 'session-completed':
      store.recordSessionCompleted({ frameId: effect.frameId, filterId: effect.filterId });
      break;
    case 'start-countdown':
      runCountdown(effect.sessionId, effect.seconds);
      break;
    case 'trigger-capture':
      io.emit('capture-now', { sessionId: effect.sessionId });
      break;
    case 'await-final-upload':
      // No-op: client uploads via POST /api/final, which dispatches finalSaved.
      break;
    case 'print-order-confirmed':
      // Staff confirmed payment on the physical terminal (out-of-band, no
      // card data touches this app). enqueueJob eagerly copies print.jpg
      // into a stable staging path before returning, so it's safe even if
      // the idle/QR sweep deletes the session folder right after this.
      printqueue.enqueueJob({
        sessionId: effect.sessionId,
        file: path.join(store.PHOTOS_DIR, effect.sessionId, 'print.jpg'),
        quantity: effect.quantity,
        unitPriceCents: effect.unitPriceCents,
      }).catch((err) => {
        console.error('Failed to enqueue print job:', err);
      });
      break;
    default:
      break;
  }
}

function runCountdown(sessionId, seconds) {
  let secondsLeft = seconds;

  function isStillValid() {
    return sessionState.sessionId === sessionId && sessionState.phase === stateMachine.PHASES.CAPTURE;
  }

  function tick() {
    if (!isStillValid()) return;
    io.emit('countdown', { value: secondsLeft });
    dispatch({ type: 'countdownTick', payload: { value: secondsLeft } });
    secondsLeft -= 1;
    if (secondsLeft > 0) {
      setTimeout(tick, 1000);
    } else {
      setTimeout(() => {
        if (!isStillValid()) return;
        dispatch({ type: 'captureNow' });
      }, 1000);
    }
  }

  tick();
}

function deleteSessionPhotos(sessionId) {
  if (!sessionId) return;
  const dir = path.join(store.PHOTOS_DIR, sessionId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

function broadcastState() {
  io.emit('state', sessionState);
}

// ---- Express app ----

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

registerRoutes(app, { getState, dispatch, port: HTTPS_PORT, httpPort: HTTP_PORT });

app.use('/photos', express.static(store.PHOTOS_DIR));
app.use('/frames', express.static(store.FRAMES_DIR));
// index: 'index.html' lets each role directory (public/control/, public/camera/, ...)
// serve its own index.html. The dynamic '/' route above is registered first, so it
// still wins for the site root instead of falling through to public/index.html (which
// does not exist).
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.use((req, res) => {
  res.status(404).send('Not found');
});

// Centralized error handler: multer (file type/size) and any other
// synchronous route errors land here instead of crashing the process
// or leaking a raw stack trace to the client.
const CLIENT_ERROR_MESSAGES = new Set([
  'unsupported_file_type',
  'invalid_session_id',
  'invalid_index',
  'LIMIT_FILE_SIZE',
]);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const code = err && (err.code || err.message);
  const isClientError = CLIENT_ERROR_MESSAGES.has(code);
  const status = isClientError ? 400 : 500;
  const error = isClientError ? code : 'internal_error';
  res.status(status).json({ ok: false, error });
});

// ---- HTTPS + HTTP redirect servers ----

const { key, cert } = getOrCreateCerts();
const httpsServer = https.createServer({ key, cert }, app);

// HTTP port serves the same app. localhost is a secure context over plain
// HTTP, so screens running on the server laptop itself (control/display) can
// skip the self-signed-cert warning entirely. LAN devices that need the
// camera (getUserMedia) must still use the HTTPS port.
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpsServer, {
  maxHttpBufferSize: 1e7,
});
io.attach(httpServer);

io.on('connection', (socket) => {
  socket.emit('state', sessionState);
  socket.emit('print-queue', printqueue.getQueueSnapshot());

  socket.on('action', (action) => {
    if (!action || typeof action.type !== 'string') return;
    dispatch(action);
  });
});

// Fires after every print-queue mutation (job creation from the
// 'print-order-confirmed' effect above, or admin retry/cancel routes).
printqueue.onQueueChange((jobs) => {
  io.emit('print-queue', jobs);
});

// ---- Idle / QR timeout sweep ----

setInterval(() => {
  const settings = store.readSettings();
  const now = Date.now();
  const elapsedSec = (now - sessionState.updatedAt) / 1000;

  if (sessionState.phase === stateMachine.PHASES.QR) {
    if (elapsedSec > settings.qrTimeoutSec) {
      dispatch({ type: 'restart' });
    }
    return;
  }

  if (sessionState.phase !== stateMachine.PHASES.IDLE) {
    if (elapsedSec > settings.idleTimeoutSec) {
      dispatch({ type: 'forceReset' });
    }
  }
}, IDLE_SWEEP_INTERVAL_MS);

// ---- Auto-delete old session photo folders ----

function sweepOldPhotos() {
  const settings = store.readSettings();
  const maxAgeMs = settings.autoDeleteHours * 60 * 60 * 1000;

  fs.readdir(store.PHOTOS_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === sessionState.sessionId) continue; // never delete the live session
      const dirPath = path.join(store.PHOTOS_DIR, entry.name);
      fs.stat(dirPath, (statErr, stats) => {
        if (statErr) return;
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > maxAgeMs) {
          fs.rm(dirPath, { recursive: true, force: true }, () => {});
        }
      });
    }
  });
}

// Staged print copies and folder-mode output are visitor photos too, so they
// must honour the same retention promise shown on the download page. Files
// belonging to a job that is still queued or printing are kept regardless of
// age, so a slow or broken printer never loses pending work.
function sweepOldPrintFiles() {
  const settings = store.readSettings();
  const maxAgeMs = settings.autoDeleteHours * 60 * 60 * 1000;
  const activeJobIds = printqueue
    .getQueueSnapshot()
    .filter((job) => job.status === 'queued' || job.status === 'printing')
    .map((job) => job.id);

  for (const dir of [printqueue.STAGING_DIR, store.PRINT_OUTBOX_DIR]) {
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        // Both naming schemes embed the job id: "<jobId>.jpg" (staging) and
        // "<timestamp>-<jobId>-x<copies>.jpg" (outbox).
        if (activeJobIds.some((jobId) => entry.name.includes(jobId))) continue;
        const filePath = path.join(dir, entry.name);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr) return;
          if (Date.now() - stats.mtimeMs > maxAgeMs) {
            fs.rm(filePath, { force: true }, () => {});
          }
        });
      }
    });
  }
}

// Deletes the cloud copy (if any) of expired token records and prunes them
// from tokens.json — the LAN-side photo files themselves are still handled
// by sweepOldPhotos above; this only concerns the cloud object + token
// bookkeeping (see server/cloud.js, server/routes.js#sweepExpiredTokens).
function sweepExpiredCloudTokens() {
  const settings = store.readSettings();
  sweepExpiredTokens(settings).catch((err) => {
    // sweepExpiredTokens already catches per-token errors internally; this
    // is just a last-resort guard so an unexpected bug never kills the
    // interval.
    console.warn('[cloud] token sweep failed unexpectedly:', err.message);
  });
}

setInterval(sweepOldPhotos, AUTO_DELETE_SWEEP_INTERVAL_MS);
sweepOldPhotos();
setInterval(sweepOldPrintFiles, AUTO_DELETE_SWEEP_INTERVAL_MS);
sweepOldPrintFiles();
setInterval(sweepExpiredCloudTokens, AUTO_DELETE_SWEEP_INTERVAL_MS);
sweepExpiredCloudTokens();

// ---- Startup ----

httpsServer.listen(HTTPS_PORT, () => {
  httpServer.listen(HTTP_PORT, () => {
    printStartupBanner();
  });
});

function printStartupBanner() {
  const lanIp = getLanIp();
  const base = `https://${lanIp}:${HTTPS_PORT}`;
  const lines = [
    '인생네컷 포토부스 서버가 시작되었습니다!',
    '',
    `설정 홈:     ${base}/`,
    `컨트롤:      ${base}/control`,
    `카메라:      ${base}/camera`,
    `리모컨:      ${base}/remote`,
    `디스플레이:  ${base}/display`,
    `관리자:      ${base}/admin`,
    '',
    `(노트북 자체 화면용: http://localhost:${HTTP_PORT} 도 사용 가능)`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '='.repeat(width);
  console.log(bar);
  for (const line of lines) {
    console.log(`= ${line.padEnd(width - 4)} =`);
  }
  console.log(bar);
}

module.exports = { app, dispatch, getState };
