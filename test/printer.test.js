'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let store;
let printer;
let srcFile;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobooth-printer-test-'));
  process.env.PHOTOBOOTH_DATA_DIR = tmpDir;
  // eslint-disable-next-line global-require
  store = require('../server/store');
  // eslint-disable-next-line global-require
  printer = require('../server/printer');
});

after(() => {
  delete process.env.PHOTOBOOTH_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  srcFile = path.join(tmpDir, 'source.jpg');
  fs.writeFileSync(srcFile, 'fake-jpeg-bytes');
  if (fs.existsSync(store.PRINT_OUTBOX_DIR)) {
    fs.rmSync(store.PRINT_OUTBOX_DIR, { recursive: true, force: true });
  }
});

test('folder mode copies the file into PRINT_OUTBOX_DIR with the expected filename shape', async () => {
  await printer.printFile(srcFile, { copies: 2, mode: 'folder', jobId: 'job123' });
  const files = fs.readdirSync(store.PRINT_OUTBOX_DIR);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d+-job123-x2\.jpg$/);
});

test('cups mode builds the correct argv array and invokes the injected exec function', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await printer.printFile(srcFile, {
    copies: 3,
    printerName: 'MyPrinter_1',
    media: '4x6',
    mode: 'cups',
    execFileImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'lp');
  assert.deepEqual(calls[0].args, ['-d', 'MyPrinter_1', '-n', '3', '-o', 'media=4x6', '-o', 'fit-to-page', srcFile]);
});

test('windows mode invokes powershell.exe with the file/printerName/copies as trailing positional args', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await printer.printFile(srcFile, {
    copies: 2,
    printerName: 'DNP_DS620',
    mode: 'windows',
    execFileImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  // The trailing three args (file, printerName, copies) are the untrusted
  // values — everything before them is the fixed script text.
  const args = calls[0].args;
  assert.deepEqual(args.slice(-3), [srcFile, 'DNP_DS620', '2']);
  assert.ok(args.includes('-NoProfile'));
});

test('windows mode rejects an invalid copies value before ever invoking execFile', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(() =>
    printer.printFile(srcFile, {
      copies: 0,
      printerName: 'DNP_DS620',
      mode: 'windows',
      execFileImpl,
    }),
  );

  assert.equal(calls.length, 0);
});

test('SECURITY: malicious printerName is rejected by allowlist validation for windows mode too', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(() =>
    printer.printFile(srcFile, {
      copies: 1,
      printerName: '"; Remove-Item C:\\ -Recurse -Force #',
      mode: 'windows',
      execFileImpl,
    }),
  );

  assert.equal(calls.length, 0, 'execFile must never be invoked with an unvalidated printerName');
});

test('unknown print mode rejects with a clear error message', async () => {
  await assert.rejects(
    () => printer.printFile(srcFile, { copies: 1, mode: 'fax' }),
    /Unknown print mode: fax/,
  );
});

test('SECURITY: malicious printerName is rejected by allowlist validation and never reaches execFile', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(() =>
    printer.printFile(srcFile, {
      copies: 1,
      printerName: 'foo; rm -rf /',
      media: '4x6',
      mode: 'cups',
      execFileImpl,
    }),
  );

  assert.equal(calls.length, 0, 'execFile must never be invoked with an unvalidated printerName');
});

test('SECURITY: malicious media value ($(whoami)) is rejected before execFile', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(() =>
    printer.printFile(srcFile, {
      copies: 1,
      printerName: 'MyPrinter',
      media: '$(whoami)',
      mode: 'cups',
      execFileImpl,
    }),
  );

  assert.equal(calls.length, 0);
});
