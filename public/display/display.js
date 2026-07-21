import { connectSocket, onState, onEvent } from '../shared/socket-state.js';
import { t } from '../shared/i18n.js';

const root = document.getElementById('root');
let countdownValue = null;

connectSocket();

onState((state) => {
  render(state);
});

onEvent('countdown', ({ value }) => {
  countdownValue = value;
});

onEvent('capture-now', () => {
  countdownValue = null;
});

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function render(state) {
  clear(root);
  if (!state) return;

  switch (state.phase) {
    case 'capture': {
      if (state.countdown !== null || countdownValue !== null) {
        const value = state.countdown !== null ? state.countdown : countdownValue;
        root.appendChild(el('div', { class: 'display-countdown' }, String(value)));
      } else {
        root.appendChild(el('div', { class: 'big-title' }, t('captureTitle')));
      }
      const grid = el('div', { class: 'display-thumb-grid' });
      for (const photo of state.photos) {
        grid.appendChild(el('img', { src: photo.file }));
      }
      root.appendChild(grid);
      break;
    }
    case 'select':
    case 'filter': {
      root.appendChild(el('div', { class: 'big-title' }, t('displaySelecting')));
      const grid = el('div', { class: 'display-thumb-grid' });
      const indices = state.phase === 'filter' ? state.picks : state.photos.map((p) => p.index);
      for (const idx of indices) {
        const photo = state.photos.find((p) => p.index === idx);
        if (photo) grid.appendChild(el('img', { src: photo.file }));
      }
      root.appendChild(grid);
      break;
    }
    case 'qr': {
      root.appendChild(el('div', { class: 'big-title' }, t('displayQr')));
      root.appendChild(
        el('div', { class: 'qr-box display-qr' }, [el('img', { src: state.qrDataUrl, alt: 'QR' })]),
      );
      break;
    }
    case 'idle':
    default: {
      root.appendChild(el('div', { class: 'big-title' }, t('displayIdle')));
      root.appendChild(el('div', { class: 'big-sub' }, t('displayIdleSub')));
      break;
    }
  }
}
