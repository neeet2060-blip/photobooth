'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let store;
let printerModule;
let printFileCalls;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-printqueue-test-'));
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  // eslint-disable-next-line global-require
  store = require('../server/store');
  // eslint-disable-next-line global-require
  printerModule = require('../server/printer');
});

after(() => {
  delete process.env.PHOTOBOOTH_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// printqueue.js reads DATA_DIR-derived paths (via store) at module-load
// time and runs a crash-recovery pass as a load-time side effect, so each
// test needs a fresh require to get isolated in-memory state (the
// `processing` flag, change listeners) while sharing the same on-disk
// tmpDir. Mirrors the require.cache-clearing pattern store.test.js implies
// for env-dependent modules.
function freshPrintQueue() {
  delete require.cache[require.resolve('../server/printqueue')];
  // eslint-disable-next-line global-require
  return require('../server/printqueue');
}

beforeEach(() => {
  for (const relPath of ['printjobs.json', 'settings.json']) {
    const p = path.join(tmpDir, relPath);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  if (fs.existsSync(store.PRINT_OUTBOX_DIR)) {
    fs.rmSync(store.PRINT_OUTBOX_DIR, { recursive: true, force: true });
  }
  const stagingDir = path.join(tmpDir, 'print-jobs');
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  // Stub out the real printer for every test; individual tests may override
  // this further (e.g. to simulate failures). This is the injectable seam:
  // printqueue.js always reads `printer.printFile` off this shared module
  // object at call time, so reassigning the property here is enough.
  printFileCalls = [];
  printerModule.printFile = async (...args) => {
    printFileCalls.push(args);
    return {};
  };
});

function makeSourceFile(name) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, 'fake-jpeg-bytes');
  return p;
}

function waitFor(conditionFn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      if (conditionFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor: condition never became true'));
        return;
      }
      setTimeout(tick, intervalMs);
    })();
  });
}

test('queued -> printing -> done happy path', async () => {
  const printqueue = freshPrintQueue();
  const src = makeSourceFile('happy-path.jpg');

  const job = await printqueue.enqueueJob({ sessionId: 's1', file: src, quantity: 2, unitPriceCents: 300 });
  assert.equal(job.status, 'queued');
  assert.equal(job.totalCents, 600);
  // The race-condition fix: enqueueJob eagerly stages its own copy, so the
  // job is independent of the original source file's lifecycle.
  assert.ok(fs.existsSync(job.file));
  assert.notEqual(job.file, src);

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === job.id);
    return Boolean(found && found.status === 'done');
  });

  assert.equal(printFileCalls.length, 1);
});

test('failure -> retry -> failed after exhausting retries', async () => {
  const printqueue = freshPrintQueue();
  printerModule.printFile = async () => {
    throw new Error('printer offline');
  };
  const src = makeSourceFile('failure-path.jpg');

  const job = await printqueue.enqueueJob({ sessionId: 's2', file: src, quantity: 1, unitPriceCents: 300 });

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === job.id);
    return Boolean(found && found.status === 'failed');
  });

  const finalJob = printqueue.getQueueSnapshot().find((j) => j.id === job.id);
  assert.equal(finalJob.status, 'failed');
  assert.equal(finalJob.attempts, 3, 'expected 1 initial attempt + 2 retries = 3 total');
  assert.match(finalJob.error, /printer offline/);
});

test('retryJob resets a failed job back to queued and it can succeed', async () => {
  const printqueue = freshPrintQueue();
  printerModule.printFile = async () => {
    throw new Error('printer offline');
  };
  const src = makeSourceFile('retry-path.jpg');
  const job = await printqueue.enqueueJob({ sessionId: 's4', file: src, quantity: 1, unitPriceCents: 300 });

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === job.id);
    return Boolean(found && found.status === 'failed');
  });

  printerModule.printFile = async (...args) => {
    printFileCalls.push(args);
    return {};
  };
  printqueue.retryJob(job.id);

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === job.id);
    return Boolean(found && found.status === 'done');
  });
});

test('cancelJob only cancels a queued job, is a no-op otherwise', async () => {
  const printqueue = freshPrintQueue();
  // Make printing hang so the job stays 'printing' long enough to attempt
  // (and fail) a cancel on it, while a second job stays safely 'queued'.
  printerModule.printFile = () => new Promise((resolve) => setTimeout(resolve, 200));
  const src = makeSourceFile('cancel-path.jpg');

  const printingJob = await printqueue.enqueueJob({ sessionId: 's5a', file: src, quantity: 1, unitPriceCents: 100 });
  const queuedJob = await printqueue.enqueueJob({ sessionId: 's5b', file: src, quantity: 1, unitPriceCents: 100 });

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === printingJob.id);
    return Boolean(found && found.status === 'printing');
  });

  const cancelResultOnPrinting = printqueue.cancelJob(printingJob.id);
  assert.equal(cancelResultOnPrinting, null);

  const cancelResultOnQueued = printqueue.cancelJob(queuedJob.id);
  assert.ok(cancelResultOnQueued);
  assert.equal(cancelResultOnQueued.status, 'canceled');

  await waitFor(() => {
    const found = printqueue.getQueueSnapshot().find((j) => j.id === printingJob.id);
    return Boolean(found && found.status === 'done');
  });
});

test('restart recovery: a job stuck in "printing" status is reset to "queued" on module load', () => {
  const printjobsPath = path.join(tmpDir, 'printjobs.json');
  const now = Date.now();
  const stuckJob = {
    id: 'pstuck1',
    sessionId: 's3',
    file: path.join(tmpDir, 'print-jobs', 'pstuck1.jpg'),
    quantity: 1,
    unitPriceCents: 300,
    totalCents: 300,
    currency: 'EUR',
    status: 'printing',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    error: null,
  };
  fs.writeFileSync(printjobsPath, JSON.stringify([stuckJob]));

  const printqueue = freshPrintQueue();
  const recovered = printqueue.getQueueSnapshot().find((j) => j.id === 'pstuck1');
  assert.ok(recovered);
  assert.equal(recovered.status, 'queued');
});

test('money math: quantity x unitPriceCents is exact integer totalCents, no floating point drift', async () => {
  const printqueue = freshPrintQueue();
  const cases = [
    { quantity: 3, unitPriceCents: 300, expected: 900 },
    { quantity: 1, unitPriceCents: 250, expected: 250 },
    { quantity: 7, unitPriceCents: 199, expected: 1393 },
    { quantity: 10, unitPriceCents: 1, expected: 10 },
  ];

  const jobs = [];
  for (const c of cases) {
    const src = makeSourceFile(`money-${c.quantity}-${c.unitPriceCents}.jpg`);
    // eslint-disable-next-line no-await-in-loop
    const job = await printqueue.enqueueJob({
      sessionId: 'money',
      file: src,
      quantity: c.quantity,
      unitPriceCents: c.unitPriceCents,
    });
    assert.equal(job.totalCents, c.expected);
    assert.ok(Number.isInteger(job.totalCents));
    jobs.push(job);
  }

  await waitFor(() => {
    const snapshot = printqueue.getQueueSnapshot();
    return jobs.every((j) => {
      const found = snapshot.find((s) => s.id === j.id);
      return Boolean(found && found.status === 'done');
    });
  });
});
