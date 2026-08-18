'use strict';

/**
 * DSLR capture via gphoto2, isolated behind a single `captureViaDslr`
 * function — mirrors server/printer.js's shape (injectable execFileImpl
 * seam for tests, execFile with an argv array rather than a shell string
 * so no filename/sessionId value ever needs shell-escaping).
 *
 * Only reachable when settings.dslrEnabled is true (see server/index.js's
 * 'trigger-capture' effect handler) — with it off, capture still goes
 * through the phone-camera browser flow (public/camera/camera.js), which
 * remains the default until a booth operator explicitly turns this on
 * with an EOS 550D physically connected over USB.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./store');

const GPHOTO2_CAPTURE_TIMEOUT_MS = 15000;

function defaultExecFileImpl(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: GPHOTO2_CAPTURE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Captures one shot with the DSLR and saves it to the exact path
 * server/routes.js's POST /api/photos would have written for this
 * sessionId/index, so the rest of the pipeline (compose, print, cloud
 * upload) can't tell the difference between a phone-uploaded shot and a
 * DSLR one.
 *
 * Captures to a temp filename first and renames into place — gphoto2
 * writes the file incrementally as the transfer comes off the camera, so
 * a reader (e.g. a compose step that raced ahead) could otherwise observe
 * a partially-written JPEG at the final path.
 */
// Forces the camera's image-format dial back to JPEG-only before every
// capture (2026-08-18, live-camera test finding). Discovered on the actual
// EOS 550D: it was set to "RAW + L" (dual RAW+JPEG), and
// --capture-image-and-download silently saved the *RAW* file under the
// .jpg filename it was given — a CR2 with a .jpg extension, which loads
// fine as a file but is not a JPEG (confirmed with `file`: "Canon CR2 raw
// image data"). Nothing downstream (compose, print, cloud upload) can
// decode that, so a booth operator bumping the mode dial mid-event would
// silently corrupt every subsequent shot with no error anywhere in this
// app. Choice '0' is 'L' (Large JPEG) in this camera's imageformat radio
// (see `gphoto2 --get-config imageformat`) — setting it is cheap and
// idempotent, so doing it before every single shot costs nothing when the
// dial was already correct and self-heals when it wasn't.
async function ensureJpegImageFormat(execFileImpl) {
  await execFileImpl('gphoto2', ['--set-config', 'imageformat=0']);
}

async function captureViaDslr(sessionId, index, { execFileImpl = defaultExecFileImpl } = {}) {
  const dir = path.join(store.PHOTOS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const destPath = path.join(dir, `${index}.jpg`);
  const tmpPath = path.join(dir, `.${index}.tmp-${Date.now()}.jpg`);

  await ensureJpegImageFormat(execFileImpl);

  await execFileImpl('gphoto2', [
    '--capture-image-and-download',
    '--filename', tmpPath,
    '--force-overwrite',
  ]);

  await fs.promises.rename(tmpPath, destPath);
  return destPath;
}

module.exports = { captureViaDslr, defaultExecFileImpl, GPHOTO2_CAPTURE_TIMEOUT_MS };
