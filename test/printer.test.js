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

test('windows mode invokes powershell.exe with a parameterized script and trailing file/printerName/copies args', async () => {
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
  // The trailing three args are parameters for the fixed .ps1 file — never
  // interpolated into PowerShell source code.
  const args = calls[0].args;
  assert.deepEqual(args.slice(-3), [srcFile, 'DNP_DS620', '2']);
  assert.ok(args.includes('-NoProfile'));
  assert.equal(args[args.indexOf('-File') + 1], path.join(__dirname, '..', 'server', 'print-windows.ps1'));
});

test('windows mode accepts a real Windows printer name containing spaces and parentheses', async () => {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '' };
  };

  // Windows names printers like this by default; rejecting spaces would make
  // windows mode unable to target any actual printer on the event PC.
  for (const name of ['EPSON ET-1810 Series', 'Canon TR8500 series (Kopie 1)']) {
    await printer.printFile(srcFile, { copies: 1, printerName: name, mode: 'windows', execFileImpl });
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-2), 'EPSON ET-1810 Series');
  assert.equal(calls[1].args.at(-2), 'Canon TR8500 series (Kopie 1)');
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

// ---- ipp mode (Canon SELPHY CP1500, 2026-08-13) ----

function stubIpp(overrides = {}) {
  const calls = { getPrinterAttributes: [], discover: 0, printJob: [] };
  const impl = {
    parseTarget: require('../server/ipp').parseTarget,
    acceptsJpeg: require('../server/ipp').acceptsJpeg,
    readyMedia: require('../server/ipp').readyMedia,
    async getPrinterAttributes(target) {
      calls.getPrinterAttributes.push(target);
      return { 'document-format-supported': ['image/jpeg'], 'media-ready': ['jpn_hagaki_100x148mm'] };
    },
    async discover() {
      calls.discover += 1;
      return { target: { host: '10.0.0.5', port: 631, path: '/ipp/print' }, media: 'jpn_hagaki_100x148mm' };
    },
    async printJob(target, data, opts) {
      calls.printJob.push({ target, size: data.length, opts });
      return { jobId: 7, jobState: 'job-printing' };
    },
    ...overrides,
  };
  return { impl, calls };
}

test('ipp mode prints to the configured address when it answers', async () => {
  const { impl, calls } = stubIpp();
  const result = await printer.printFile(srcFile, {
    mode: 'ipp', copies: 2, printerUrl: '172.20.10.10', ippImpl: impl,
  });

  assert.equal(calls.discover, 0, 'no need to go looking when the address works');
  assert.equal(calls.printJob.length, 1);
  assert.equal(calls.printJob[0].target.host, '172.20.10.10');
  assert.equal(calls.printJob[0].opts.copies, 2);
  assert.equal(result.discovered, false);
  assert.equal(result.jobState, 'job-printing');
});

test('ipp mode uses the paper the printer reports as loaded', async () => {
  const { impl, calls } = stubIpp();
  await printer.printFile(srcFile, { mode: 'ipp', copies: 1, printerUrl: '172.20.10.10', ippImpl: impl });
  assert.equal(calls.printJob[0].opts.media, 'jpn_hagaki_100x148mm');
});

test('ipp mode falls back to discovery when the configured address has gone stale', async () => {
  // The venue runs on a phone hotspot, which hands the printer a different
  // address every restart — a saved address going stale is the normal case,
  // not an error worth failing a paid print over.
  const { impl, calls } = stubIpp({
    async getPrinterAttributes() { throw new Error('ECONNREFUSED'); },
  });

  const result = await printer.printFile(srcFile, {
    mode: 'ipp', copies: 1, printerUrl: '172.20.10.99', ippImpl: impl,
  });

  assert.equal(calls.discover, 1);
  assert.equal(calls.printJob[0].target.host, '10.0.0.5');
  assert.equal(result.discovered, true);
});

test('ipp mode discovers the printer when no address is configured at all', async () => {
  const { impl, calls } = stubIpp();
  const result = await printer.printFile(srcFile, { mode: 'ipp', copies: 1, printerUrl: '', ippImpl: impl });
  assert.equal(calls.discover, 1);
  assert.equal(result.discovered, true);
});

test('ipp mode refuses a printer that cannot take a JPEG rather than sending one blindly', async () => {
  const { impl, calls } = stubIpp({
    async getPrinterAttributes() { return { 'document-format-supported': ['image/pwg-raster'] }; },
    async discover() { calls_discoverNull += 1; return null; },
  });
  let calls_discoverNull = 0;
  await assert.rejects(
    () => printer.printFile(srcFile, { mode: 'ipp', copies: 1, printerUrl: '172.20.10.10', ippImpl: impl }),
    /No IPP printer found/,
  );
  assert.equal(calls.printJob.length, 0, 'must not send a job to a printer that rejected the format');
});

test('ipp mode rejects an invalid copies value before reading the file', async () => {
  const { impl, calls } = stubIpp();
  await assert.rejects(
    () => printer.printFile(srcFile, { mode: 'ipp', copies: 0, printerUrl: '172.20.10.10', ippImpl: impl }),
    /Invalid copies/,
  );
  assert.equal(calls.printJob.length, 0);
});
