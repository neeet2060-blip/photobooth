'use strict';

/**
 * Physical print execution, isolated behind a single `printFile` function.
 *
 * This module never touches payment/state — printqueue.js decides *when* to
 * print (after staff confirms payment out-of-band); this module only knows
 * *how* to get a JPEG onto paper (or, in 'folder' mode, into a staging
 * folder that a human or another tool can print from later).
 *
 * Testability seam: the `execFileImpl` param defaults to a promisified
 * wrapper around `require('child_process').execFile`, but a test can pass
 * its own stub instead of monkey-patching the child_process module.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./store');

// Same allowlist used by server/routes.js when validating admin settings
// (printerName/printMedia) — keep these two definitions in sync.
// Real-world Windows/CUPS printer names routinely contain spaces and
// parentheses (e.g. "Canon SELPHY CP1500", "DNP DS620 (Copy 1)") — the
// original letters/digits/underscore/period/hyphen-only pattern rejected
// every realistic Windows printer name, which would have silently broken
// printMode:'windows' the moment an operator pasted their actual printer
// name into the admin settings form (2026-08-11 pre-launch audit finding,
// fixed independently on both sides of a concurrent merge). This is a
// sanity check, not the injection defense: printerName is always passed to
// execFile as a positional argv/script argument (see
// printCupsMode/printWindowsMode), never interpolated into a shell command
// or script string, so broadening the charset here doesn't reopen any
// injection surface.
const PRINTER_NAME_REGEX = /^[a-zA-Z0-9 ()_.-]{1,80}$/;
const PRINT_MEDIA_REGEX = /^[a-zA-Z0-9x]{1,16}$/;

function defaultExecFileImpl(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function printFolderMode(filePath, { copies, jobId }) {
  store.ensureDirs();
  const destName = `${Date.now()}-${jobId}-x${copies}.jpg`;
  const destPath = path.join(store.PRINT_OUTBOX_DIR, destName);
  await fs.promises.copyFile(filePath, destPath);
  return { mode: 'folder', outputPath: destPath };
}

async function printCupsMode(filePath, { copies, printerName, media, execFileImpl }) {
  if (!PRINTER_NAME_REGEX.test(printerName || '')) {
    throw new Error(`Invalid printerName for cups mode: ${JSON.stringify(printerName)}`);
  }
  if (!PRINT_MEDIA_REGEX.test(media || '')) {
    throw new Error(`Invalid media for cups mode: ${JSON.stringify(media)}`);
  }
  // Argv array (never a shell string) — printerName/media are validated
  // above against strict allowlists before ever reaching execFile.
  const args = ['-d', printerName, '-n', String(copies), '-o', `media=${media}`, '-o', 'fit-to-page', filePath];
  await execFileImpl('lp', args);
  return { mode: 'cups', args };
}

// Prints via .NET's System.Drawing.Printing.PrintDocument, which ships with
// every Windows install (no CUPS/'lp' equivalent exists on Windows, and no
// extra tool like SumatraPDF needs to be installed). The image is stretched
// to the page bounds — matches cups mode's 'fit-to-page' behavior — so the
// printer driver's configured paper size (set once in Windows' printer
// properties, e.g. 4x6) determines the physical output size.
//
// Use -File with a real .ps1 script instead of -Command with trailing
// arguments. PowerShell does not reliably bind arguments placed after
// -Command into $args (Windows testing on 2026-08-13 found this made every
// windows-mode print job fail before reaching the printer — an empty file
// path, not just a wrong paper size). -File binds these three values to the
// named param() block in print-windows.ps1 instead; they remain distinct
// argv elements, never interpolated into PowerShell source code, so
// printerName's allowlist validation below is still the only defense that
// matters (not string-safety of the script itself).
const WINDOWS_PRINT_SCRIPT_FILE = path.join(__dirname, 'print-windows.ps1');

async function printWindowsMode(filePath, { copies, printerName, execFileImpl }) {
  if (!PRINTER_NAME_REGEX.test(printerName || '')) {
    throw new Error(`Invalid printerName for windows mode: ${JSON.stringify(printerName)}`);
  }
  const copiesNum = Number(copies);
  if (!Number.isInteger(copiesNum) || copiesNum < 1) {
    throw new Error(`Invalid copies for windows mode: ${JSON.stringify(copies)}`);
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_PRINT_SCRIPT_FILE,
    filePath, printerName, String(copiesNum),
  ];
  await execFileImpl('powershell.exe', args);
  return { mode: 'windows', args };
}

/**
 * @param {string} filePath - JPEG file to print
 * @param {object} opts
 * @param {number} opts.copies
 * @param {string} [opts.printerName]
 * @param {string} [opts.media]
 * @param {object} [opts.extraOptions]
 * @param {'folder'|'cups'|'windows'} opts.mode
 * @param {string} [opts.jobId] - required for 'folder' mode (used in the output filename)
 * @param {(cmd: string, args: string[]) => Promise<any>} [opts.execFileImpl] - injectable for tests
 * @returns {Promise<object>}
 */
function printFile(filePath, opts = {}) {
  const { copies, printerName, media, mode, jobId, execFileImpl = defaultExecFileImpl } = opts;

  if (mode === 'folder') {
    return printFolderMode(filePath, { copies, jobId });
  }
  if (mode === 'cups') {
    return printCupsMode(filePath, { copies, printerName, media, execFileImpl });
  }
  if (mode === 'windows') {
    return printWindowsMode(filePath, { copies, printerName, execFileImpl });
  }
  return Promise.reject(new Error(`Unknown print mode: ${mode}`));
}

module.exports = { printFile, PRINTER_NAME_REGEX, PRINT_MEDIA_REGEX };
