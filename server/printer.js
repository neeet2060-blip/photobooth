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
const PRINTER_NAME_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;
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

/**
 * @param {string} filePath - JPEG file to print
 * @param {object} opts
 * @param {number} opts.copies
 * @param {string} [opts.printerName]
 * @param {string} [opts.media]
 * @param {object} [opts.extraOptions]
 * @param {'folder'|'cups'} opts.mode
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
  return Promise.reject(new Error(`Unknown print mode: ${mode}`));
}

module.exports = { printFile, PRINTER_NAME_REGEX, PRINT_MEDIA_REGEX };
