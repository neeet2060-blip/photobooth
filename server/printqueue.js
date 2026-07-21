'use strict';

/**
 * Single-flight print job queue. One physical printer, so at most one job
 * is ever 'printing' at a time; jobs are processed FIFO by createdAt.
 *
 * Job shape:
 *   { id, sessionId, file, quantity, unitPriceCents, totalCents, currency,
 *     status: 'queued'|'printing'|'done'|'failed'|'canceled',
 *     createdAt, updatedAt, attempts, error }
 *
 * Race-condition note (see PRINTING.md): the session's print.jpg can be
 * deleted (abandon/idle sweep) shortly after a print order is confirmed.
 * To make the job immune to that, enqueueJob() eagerly copies the source
 * file into a stable staging directory *before* returning, so index.js can
 * safely let the session folder get cleaned up afterward.
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const printer = require('./printer');

const STAGING_DIR = path.join(store.DATA_DIR, 'print-jobs');
const MAX_ATTEMPTS = 3; // 1 initial try + up to 2 retries
const RETRY_BACKOFF_MS = 500;
const CURRENCY = 'EUR';

const changeListeners = [];

function genJobId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function notifyChange() {
  const snapshot = getQueueSnapshot();
  for (const listener of changeListeners) {
    listener(snapshot);
  }
}

function onQueueChange(callback) {
  changeListeners.push(callback);
  return () => {
    const idx = changeListeners.indexOf(callback);
    if (idx !== -1) changeListeners.splice(idx, 1);
  };
}

function getQueueSnapshot() {
  return store.readPrintJobs();
}

function updateJob(jobId, patch) {
  const jobs = store.readPrintJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  const next = [...jobs];
  next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() };
  store.writePrintJobs(next);
  notifyChange();
  return next[idx];
}

function getJobById(jobId) {
  return store.readPrintJobs().find((j) => j.id === jobId) || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Eagerly copies `file` into a stable staging path and persists a new
 * 'queued' job. Returns the created job (with `file` pointing at the
 * staged copy, not the original session path).
 */
async function enqueueJob({ sessionId, file, quantity, unitPriceCents }) {
  const id = genJobId();
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const stagedFile = path.join(STAGING_DIR, `${id}.jpg`);
  await fs.promises.copyFile(file, stagedFile);

  const now = Date.now();
  const job = {
    id,
    sessionId,
    file: stagedFile,
    quantity,
    unitPriceCents,
    totalCents: quantity * unitPriceCents,
    currency: CURRENCY,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    error: null,
  };

  const jobs = store.readPrintJobs();
  store.writePrintJobs([...jobs, job]);
  notifyChange();
  kickWorker();
  return job;
}

function retryJob(id) {
  const job = getJobById(id);
  if (!job || job.status !== 'failed') return null;
  // Reset attempts to 0 for a fresh 3-attempt budget on manual retry.
  const next = updateJob(id, { status: 'queued', attempts: 0, error: null });
  kickWorker();
  return next;
}

function cancelJob(id) {
  const job = getJobById(id);
  if (!job || job.status !== 'queued') return null;
  return updateJob(id, { status: 'canceled' });
}

let processing = false;

function kickWorker() {
  if (processing) return;
  processing = true;
  // Deferred to the next tick (rather than starting synchronously) so that
  // callers — including the module-load crash-recovery pass below — can
  // observe the just-written 'queued' status before the worker picks it up.
  setImmediate(() => {
    processNext().catch(() => {
      // processNext already routes failures into job.error/status; this catch
      // only guards against an unexpected bug so the worker never dies silently.
      processing = false;
    });
  });
}

async function processNext() {
  const jobs = store.readPrintJobs();
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const next = queued[0];
  if (!next) {
    processing = false;
    return;
  }
  await runJob(next.id);
  return processNext();
}

async function runJob(jobId) {
  const initial = getJobById(jobId);
  if (!initial) return;
  updateJob(jobId, { status: 'printing' });

  for (let attempt = initial.attempts; attempt < MAX_ATTEMPTS; attempt += 1) {
    const settings = store.readSettings();
    const job = getJobById(jobId);
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await printer.printFile(job.file, {
        copies: job.quantity,
        printerName: settings.printerName,
        media: settings.printMedia,
        mode: settings.printMode,
        jobId: job.id,
        extraOptions: {},
      });
      // Record which transport actually handled it, so the admin UI can say
      // "파일 저장됨" vs "프린터로 전송됨" instead of a bare "완료" — the mode
      // can change in settings later, so it must be stored per job.
      updateJob(jobId, { status: 'done', mode: (result && result.mode) || null });
      return;
    } catch (err) {
      const attempts = attempt + 1;
      const isLastAttempt = attempts >= MAX_ATTEMPTS;
      updateJob(jobId, {
        attempts,
        error: String((err && err.message) || err),
        status: isLastAttempt ? 'failed' : 'printing',
      });
      if (isLastAttempt) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(RETRY_BACKOFF_MS);
    }
  }
}

// ---- Crash recovery, run once at module load ----
// If the process died mid-print, the job would be stuck in 'printing'
// forever; reset any such job back to 'queued' so it gets retried.
(function recoverStuckJobs() {
  const jobs = store.readPrintJobs();
  let changed = false;
  const recovered = jobs.map((job) => {
    if (job.status === 'printing') {
      changed = true;
      return { ...job, status: 'queued', updatedAt: Date.now() };
    }
    return job;
  });
  if (changed) {
    store.writePrintJobs(recovered);
  }
  kickWorker();
})();

module.exports = {
  STAGING_DIR,
  enqueueJob,
  retryJob,
  cancelJob,
  onQueueChange,
  getQueueSnapshot,
};
