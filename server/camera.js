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
async function captureViaDslr(sessionId, index, { execFileImpl = defaultExecFileImpl } = {}) {
  const dir = path.join(store.PHOTOS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const destPath = path.join(dir, `${index}.jpg`);
  const tmpPath = path.join(dir, `.${index}.tmp-${Date.now()}.jpg`);

  await execFileImpl('gphoto2', [
    '--capture-image-and-download',
    '--filename', tmpPath,
    '--force-overwrite',
  ]);

  await fs.promises.rename(tmpPath, destPath);
  return destPath;
}

module.exports = { captureViaDslr, defaultExecFileImpl, GPHOTO2_CAPTURE_TIMEOUT_MS };
