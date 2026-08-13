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
// filePath/printerName/copies are passed as trailing positional args to
// powershell.exe (read back via $args[0..2] inside the script), never
// string-interpolated into the script text itself — so even though
// printerName is already allowlist-validated below, there is no path by
// which any of these three values could be interpreted as PowerShell syntax.
const WINDOWS_PRINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$file = $args[0]
$printerName = $args[1]
$copies = [int]$args[2]
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($file)
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $printerName
  if (-not $doc.PrinterSettings.IsValid) {
    throw "Printer not found or not ready: $printerName"
  }
  $doc.PrinterSettings.Copies = [int16]$copies

  # 2026-08-13 (frame corners getting cropped at print time) — this used to
  # trust whatever paper size/orientation was already the driver's default,
  # set manually once in Windows' printer properties UI. Our composited file
  # is always exactly 4x6in portrait (server/compose.js), so if that manual
  # default ever drifts (driver update, a different paper size briefly
  # selected for a test print, a second printer sharing the same driver
  # profile), .NET stretches our 4x6 image into whatever the wrong page box
  # turns out to be and the frame's edges get cut off — with nothing in our
  # own code to blame. Selecting the driver's own '~4x6' PaperSize (falling
  # back to a custom one if the driver doesn't expose one) and forcing
  # portrait + zero margins makes this deterministic instead of depending on
  # a manual setting nobody will remember to re-check on event day.
  $target = $doc.PrinterSettings.PaperSizes | Where-Object {
    [Math]::Abs($_.Width - 400) -le 20 -and [Math]::Abs($_.Height - 600) -le 20
  } | Select-Object -First 1
  if ($target) {
    $doc.DefaultPageSettings.PaperSize = $target
  } else {
    $doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('4x6', 400, 600)
  }
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

  $doc.add_PrintPage({
    param($sender, $e)
    $e.Graphics.DrawImage($img, $e.PageBounds)
  })
  $doc.Print()
} finally {
  $img.Dispose()
}
`;

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
    '-Command', WINDOWS_PRINT_SCRIPT,
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
