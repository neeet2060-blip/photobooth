import { connectSocket, onState, onEvent } from '../shared/socket-state.js';
import { t } from '../shared/i18n.js';

const video = document.getElementById('video');
const captureCanvas = document.getElementById('capture-canvas');
const statusBar = document.getElementById('status-bar');
const startOverlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const startTitle = document.getElementById('start-title');
const mirrorBtn = document.getElementById('mirror-btn');

const CAPTURE_WIDTH = 1600;
const CAPTURE_HEIGHT = 1200; // 4:3

let lastState = null;
let mirrored = false;
let wakeLock = null;
let countdownOverlayEl = null;

startTitle.textContent = t('cameraWaiting');
startBtn.textContent = t('cameraStart');
mirrorBtn.textContent = t('cameraMirror');

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

startBtn.addEventListener('click', async () => {
  try {
    await startCamera();
    startOverlay.style.display = 'none';
    requestWakeLock();
  } catch (err) {
    startTitle.textContent = `${t('errorGeneric')}: ${err.message}`;
  }
});

mirrorBtn.addEventListener('click', () => {
  mirrored = !mirrored;
  video.classList.toggle('mirror', mirrored);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

async function startCamera() {
  const constraintsList = [
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
      await video.play();
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
