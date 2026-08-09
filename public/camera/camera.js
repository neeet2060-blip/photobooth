import { connectSocket, onState, onEvent } from '../shared/socket-state.js';
import { t } from '../shared/i18n.js';

const video = document.getElementById('video');
const captureCanvas = document.getElementById('capture-canvas');
const statusBar = document.getElementById('status-bar');
const startOverlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const startTitle = document.getElementById('start-title');
const mirrorBtn = document.getElementById('mirror-btn');
const cameraSelect = document.getElementById('camera-select');

const CAPTURE_WIDTH = 1600;
const CAPTURE_HEIGHT = 1200; // 4:3
// Persists the operator's camera pick (e.g. a DSLR exposed as a webcam via
// Canon EOS Webcam Utility) across reloads, since a laptop with a built-in
// camera AND a tethered DSLR will otherwise fall back to an arbitrary one.
const CAMERA_DEVICE_STORAGE_KEY = 'photobooth-camera-device-id';

let lastState = null;
let mirrored = false;
let wakeLock = null;
let countdownOverlayEl = null;

startTitle.textContent = t('cameraWaiting');
startBtn.textContent = t('cameraStart');
mirrorBtn.textContent = t('cameraMirror');
cameraSelect.setAttribute('aria-label', t('cameraSelectLabel'));

connectSocket();

onState((state) => {
  lastState = state;
  updateStatus();
});

onEvent('countdown', ({ value }) => {
  showCountdown(value);
});

onEvent('capture-now', ({ sessionId }) => {
  hideCountdown();
  if (!lastState || lastState.phase !== 'capture' || lastState.sessionId !== sessionId) return;
  captureAndUpload();
});

let startInProgress = false;

startBtn.addEventListener('click', async () => {
  // Guards against a double-click (or an impatient second click while a slow
  // virtual camera — e.g. a DSLR via EOS Webcam Utility — is still spinning
  // up) firing a second overlapping getUserMedia()/video.play() call, which
  // races the first and surfaces as "play() request was interrupted by a new
  // load request."
  if (startInProgress) return;
  startInProgress = true;
  startBtn.disabled = true;
  try {
    await startCamera();
    startOverlay.style.display = 'none';
    requestWakeLock();
  } catch (err) {
    startTitle.textContent = `${t('errorGeneric')}: ${err.message}`;
  } finally {
    startInProgress = false;
    startBtn.disabled = false;
  }
});

populateCameraList();

mirrorBtn.addEventListener('click', () => {
  mirrored = !mirrored;
  video.classList.toggle('mirror', mirrored);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/**
 * Populates the camera picker BEFORE the operator presses "카메라 시작", so a
 * laptop with both a built-in webcam and a tethered DSLR (via Canon EOS
 * Webcam Utility or similar) lets the operator pick the right one instead of
 * silently getting whichever the browser defaults to. Only shown when more
 * than one video input exists — a single-camera device (a phone) never
 * needs this and stays exactly as before.
 */
async function populateCameraList() {
  let probeStream = null;
  try {
    // Device labels are blank until a getUserMedia grant has happened at
    // least once; this probe stream exists only to unlock labels and is
    // stopped immediately, before the operator ever sees a preview.
    probeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (_) {
    return; // No camera access yet — the normal "카메라 시작" flow still works.
  } finally {
    if (probeStream) probeStream.getTracks().forEach((track) => track.stop());
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  if (videoInputs.length <= 1) return; // Nothing to choose between.

  const savedDeviceId = localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY);
  videoInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${t('cameraSelectDefault')} ${index + 1}`;
    cameraSelect.appendChild(option);
  });
  if (savedDeviceId && videoInputs.some((d) => d.deviceId === savedDeviceId)) {
    cameraSelect.value = savedDeviceId;
  }
  cameraSelect.style.display = '';
}

async function startCamera() {
  const selectedDeviceId = cameraSelect.style.display !== 'none' ? cameraSelect.value : '';
  const constraintsList = [
    ...(selectedDeviceId ? [{ video: { deviceId: { exact: selectedDeviceId } }, audio: false }] : []),
    { video: { facingMode: { exact: 'environment' } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: { facingMode: 'user' }, audio: false },
    { video: true, audio: false },
  ];

  let lastErr = null;
  for (const constraints of constraintsList) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      try {
        await video.play();
      } catch (playErr) {
        // Some virtual cameras (e.g. a DSLR exposed via EOS Webcam Utility)
        // swap their internal source once while spinning up, which can abort
        // this first play() with "interrupted by a new load request" even
        // though the stream itself is fine — one retry (same stream, no new
        // getUserMedia call) clears it without discarding a working device.
        if (playErr && playErr.name === 'AbortError') {
          await video.play();
        } else {
          throw playErr;
        }
      }
      if (selectedDeviceId) localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, selectedDeviceId);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('camera_unavailable');
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {
    // Best effort only.
  }
}

function updateStatus() {
  if (!lastState) return;
  const taken = lastState.shotsTaken;
  const total = lastState.shotsTotal;
  statusBar.textContent = `${lastState.phase} ${total ? `(${taken}/${total})` : ''}`;
}

function showCountdown(value) {
  hideCountdown();
  countdownOverlayEl = document.createElement('div');
  countdownOverlayEl.className = 'countdown-overlay';
  countdownOverlayEl.textContent = String(value);
  document.body.appendChild(countdownOverlayEl);
}

function hideCountdown() {
  if (countdownOverlayEl) {
    countdownOverlayEl.remove();
    countdownOverlayEl = null;
  }
}

function drawCoverCrop(ctx, videoEl, targetW, targetH) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const targetRatio = targetW / targetH;
  const videoRatio = vw / vh;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (videoRatio > targetRatio) {
    sw = vh * targetRatio;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / targetRatio;
    sy = (vh - sh) / 2;
  }
  ctx.save();
  if (mirrored) {
    ctx.translate(targetW, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, targetW, targetH);
  ctx.restore();
}

async function captureAndUpload() {
  if (!lastState) return;
  const index = lastState.shotsTaken;
  captureCanvas.width = CAPTURE_WIDTH;
  captureCanvas.height = CAPTURE_HEIGHT;
  const ctx = captureCanvas.getContext('2d');
  drawCoverCrop(ctx, video, CAPTURE_WIDTH, CAPTURE_HEIGHT);

  captureCanvas.toBlob(
    async (blob) => {
      if (!blob) return;
      try {
        const formData = new FormData();
        formData.append('sessionId', lastState.sessionId);
        formData.append('index', String(index));
        formData.append('photo', blob, `${index}.jpg`);
        await fetch('/api/photos', { method: 'POST', body: formData });
      } catch (_) {
        // The state broadcast will reflect the true shot count either way;
        // on failure the operator can retake in the select phase.
      }
    },
    'image/jpeg',
    0.9,
  );
}
