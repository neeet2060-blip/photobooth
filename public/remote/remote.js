import { connectSocket, onState, sendAction } from '../shared/socket-state.js';
import { t, mountLangToggle } from '../shared/i18n.js';

const title = document.getElementById('title');
const info = document.getElementById('info');
const shutter = document.getElementById('shutter');

mountLangToggle(document.body, () => update(lastState));

title.textContent = t('remoteTitle');
shutter.textContent = t('shutterButton');

let lastState = null;
let countingDown = false;

connectSocket();

onState((state) => {
  lastState = state;
  countingDown = state.countdown !== null;
  update(state);
});

shutter.addEventListener('click', () => {
  sendAction('shutter');
});

function update(state) {
  if (!state) return;
  title.textContent = t('remoteTitle');
  shutter.textContent = t('shutterButton');
  const inCapture = state.phase === 'capture';
  const remaining = Math.max((state.shotsTotal || 0) - (state.shotsTaken || 0), 0);
  info.textContent = inCapture ? t('remoteShots', { remaining }) : t('remoteWaiting');
  shutter.disabled = !inCapture || countingDown || remaining <= 0;
}
