import { connectSocket, onState, onEvent, sendAction } from '../shared/socket-state.js';
import { t, mountLangToggle } from '../shared/i18n.js';
import { composeFrame, composePrintSheet, canvasToJpegBlob } from '../shared/compose.js';

const root = document.getElementById('root');
mountLangToggle(document.body, () => render(lastState));

let lastState = null;
let framesCache = [];
let filtersCache = [];
let countdownValue = null;
let framesFetchedForSession = false;
// Print pricing isn't pushed over the socket state broadcast, so we fetch it
// once from the (unauthenticated, LAN-only) admin settings endpoint — the
// same one the admin UI reads — purely to show a total in the print-order
// UI. If this fetch fails, the UI still works with quantity-only display.
let printSettingsCache = null;

connectSocket();

onState((state) => {
  lastState = state;
  // Clear the last-seen countdown value once the server says the countdown is
  // over, otherwise the capture screen would keep showing the final "1".
  if (state.countdown === null) countdownValue = null;
  render(state);
});

onEvent('countdown', ({ value }) => {
  countdownValue = value;
  render(lastState);
});

fetch('/api/filters')
  .then((r) => r.json())
  .then((d) => {
    filtersCache = d.filters || [];
  })
  .catch(() => {});

fetch('/api/admin/settings')
  .then((r) => r.json())
  .then((d) => {
    printSettingsCache = d.settings || null;
    render(lastState);
  })
  .catch(() => {});

function refreshFrames() {
  return fetch('/api/frames')
    .then((r) => r.json())
    .then((d) => {
      framesCache = d.frames || [];
    })
    .catch(() => {
      framesCache = [];
    });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
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
  if (!state) {
    root.appendChild(el('div', { class: 'screen' }, [el('h1', {}, '...')]));
    return;
  }

  // Reset the one-shot frame fetch flag whenever we are outside format/theme,
  // so the next entry re-fetches the latest frames exactly once. Both phases
  // read from the same framesCache (format needs it to know which layouts
  // exist; theme needs it to show the frame cards for the chosen layout).
  if (state.phase !== 'format' && state.phase !== 'theme') framesFetchedForSession = false;

  switch (state.phase) {
    case 'idle':
      root.appendChild(renderIdle());
      break;
    case 'consent':
      root.appendChild(renderConsent());
      break;
    case 'format':
      root.appendChild(renderFormat(state));
      if (!framesFetchedForSession) {
        framesFetchedForSession = true;
        refreshFrames().then(() => render(lastState));
      }
      break;
    case 'theme':
      root.appendChild(renderTheme(state));
      // Fetch frames only once per format/theme entry — re-fetching on every
      // render caused an infinite fetch→render loop that constantly rebuilt the
      // DOM and made frame cards impossible to tap.
      if (!framesFetchedForSession) {
        framesFetchedForSession = true;
        refreshFrames().then(() => render(lastState));
      }
      break;
    case 'quantity':
      root.appendChild(renderQuantity(state));
      break;
    case 'payment':
      root.appendChild(renderPayment(state));
      break;
    case 'capture':
      root.appendChild(renderCapture(state));
      break;
    case 'select':
      root.appendChild(renderSelect(state));
      break;
    case 'filter':
      root.appendChild(renderFilter(state));
      break;
    case 'qr':
      root.appendChild(renderQr(state));
      break;
    default:
      root.appendChild(el('div', { class: 'screen' }, [el('h1', {}, 'Unknown phase')]));
  }
}

function renderIdle() {
  return el('div', { class: 'screen' }, [
    el('h1', {}, t('attractTitle')),
    el('p', {}, t('attractSubtitle')),
    el('button', { class: 'primary big-button', onclick: () => sendAction('start') }, t('startButton')),
  ]);
}

function renderConsent() {
  return el('div', { class: 'screen' }, [
    el('h1', {}, t('consentTitle')),
    el('p', { style: 'max-width:640px;line-height:1.6;' }, t('consentBody')),
    el('div', { style: 'display:flex;gap:16px;' }, [
      el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
      el('button', { class: 'primary', onclick: () => sendAction('agree') }, t('agreeButton')),
    ]),
  ]);
}

const FORMAT_LABEL_KEYS = { strip: 'formatOptionStrip', grid: 'formatOptionGrid' };

function renderFormat() {
  const layouts = [...new Set(framesCache.filter((f) => f.active).map((f) => f.layout))];
  const grid = el('div', { class: 'frame-grid' });
  for (const layoutId of layouts) {
    const sample = framesCache.find((f) => f.active && f.layout === layoutId);
    const label = FORMAT_LABEL_KEYS[layoutId] ? t(FORMAT_LABEL_KEYS[layoutId]) : layoutId;
    grid.appendChild(
      el('div', { class: 'frame-card', onclick: () => sendAction('chooseFormat', { layoutId }) }, [
        sample ? el('img', { src: sample.file, alt: label }) : null,
        el('div', {}, label),
      ]),
    );
  }
  return el('div', { class: 'screen' }, [el('h1', {}, t('formatTitle')), grid]);
}

function renderTheme(state) {
  const grid = el('div', { class: 'frame-grid' });
  for (const frame of framesCache.filter((f) => f.layout === state.layoutId)) {
    grid.appendChild(
      el('div', { class: 'frame-card', onclick: () => sendAction('chooseTheme', { frameId: frame.id }) }, [
        el('img', { src: frame.file, alt: frame.name }),
        el('div', {}, frame.name),
      ]),
    );
  }
  return el('div', { class: 'screen' }, [el('h1', {}, t('themeTitle')), grid]);
}

function renderCapture(state) {
  const lastPhoto = state.photos[state.photos.length - 1];
  const children = [
    el('h1', {}, t('captureTitle')),
    el('div', { class: 'progress-text' }, t('shotsProgress', { taken: state.shotsTaken, total: state.shotsTotal })),
  ];

  if (lastPhoto) {
    children.push(el('div', { class: 'thumb', style: 'width:240px;' }, [el('img', { src: lastPhoto.file })]));
  }

  const canShutter = state.countdown === null;
  children.push(
    el(
      'button',
      { class: 'primary big-button', disabled: canShutter ? null : 'disabled', onclick: () => sendAction('shutter') },
      t('shutterButton'),
    ),
  );

  if (state.photos.length >= 4) {
    children.push(el('button', { onclick: () => sendAction('finishEarly') }, t('finishEarlyButton')));
  }

  if (state.countdown !== null || countdownValue !== null) {
    const value = state.countdown !== null ? state.countdown : countdownValue;
    children.push(el('div', { class: 'countdown-overlay' }, String(value)));
  }

  return el('div', { class: 'screen' }, children);
}

function renderSelect(state) {
  const grid = el('div', { class: 'thumb-grid' });
  for (const photo of state.photos) {
    const pickIndex = state.picks.indexOf(photo.index);
    const thumb = el(
      'div',
      { class: `thumb${pickIndex !== -1 ? ' picked' : ''}`, onclick: () => sendAction('togglePick', { index: photo.index }) },
      [el('img', { src: photo.file })],
    );
    if (pickIndex !== -1) {
      thumb.appendChild(el('div', { class: 'pick-badge' }, String(pickIndex + 1)));
    }
    grid.appendChild(thumb);
  }

  return el('div', { class: 'screen' }, [
    el('h1', {}, t('selectTitle')),
    el('div', { class: 'progress-text' }, t('selectProgress', { count: state.picks.length })),
    grid,
    el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;justify-content:center;' }, [
      el('button', { onclick: () => sendAction('retake') }, t('retakeButton')),
      el('button', { onclick: () => sendAction('changeTheme') }, t('changeThemeButton')),
      el(
        'button',
        {
          class: 'primary',
          disabled: state.picks.length === 4 ? null : 'disabled',
          onclick: () => sendAction('confirmPicks'),
        },
        t('confirmPicksButton'),
      ),
    ]),
  ]);
}

function renderFilter(state) {
  const canvas = el('canvas', { style: 'max-width:320px;width:100%;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);' });
  const frame = framesCache.find((f) => f.id === state.frameId);
  const orderedPhotoUrls = state.picks.map((idx) => state.photos.find((p) => p.index === idx).file);

  const chips = el('div', { class: 'filter-chips' });
  const filters = filtersCache.length ? filtersCache : [{ id: 'none', css: 'none' }];

  const redraw = () => {
    if (!frame) return;
    const activeFilter = filters.find((f) => f.id === state.filterId) || filters[0];
    composeFrame({
      canvas,
      layoutName: frame.layout,
      photoUrls: orderedPhotoUrls,
      frameUrl: frame.file,
      filterCss: activeFilter.css,
    }).catch(() => {});
  };

  for (const filterDef of filters) {
    chips.appendChild(
      el(
        'div',
        {
          class: `filter-chip${filterDef.id === state.filterId ? ' active' : ''}`,
          onclick: () => sendAction('chooseFilter', { id: filterDef.id }),
        },
        filterLabel(filterDef.id),
      ),
    );
  }

  const confirmBtn = el(
    'button',
    { class: 'primary big-button' },
    t('confirmFinalButton'),
  );
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      const blob = await canvasToJpegBlob(canvas, 0.92);
      const formData = new FormData();
      formData.append('sessionId', state.sessionId);
      formData.append('photo', blob, 'final.jpg');
      // The server transitions filter→qr itself when /api/final succeeds.
      const res = await fetch('/api/final', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('upload_failed');
    } catch (err) {
      confirmBtn.disabled = false;
      alert(t('errorGeneric'));
      return;
    }

    // Print-sheet upload is a background nice-to-have for the paid printing
    // add-on: it must never block, delay, or fail the visitor-facing
    // final.jpg/finalSaved flow above, so any failure here is only logged.
    try {
      const activeFilter = filtersCache.find((f) => f.id === state.filterId) || { css: 'none' };
      const printCanvas = document.createElement('canvas');
      await composePrintSheet({
        canvas: printCanvas,
        layoutName: frame.layout,
        photoUrls: orderedPhotoUrls,
        frameUrl: frame.file,
        filterCss: activeFilter.css,
      });
      const printBlob = await canvasToJpegBlob(printCanvas, 0.92);
      const printFormData = new FormData();
      printFormData.append('sessionId', state.sessionId);
      printFormData.append('photo', printBlob, 'print.jpg');
      const printRes = await fetch('/api/print-sheet', { method: 'POST', body: printFormData });
      if (!printRes.ok) throw new Error('print_sheet_upload_failed');
    } catch (err) {
      console.error('print-sheet upload failed (non-blocking):', err);
    }
  });

  if (!framesCache.length) {
    refreshFrames().then(() => render(lastState));
  } else {
    // Redraw once images are ready (after DOM insertion, canvas has real size).
    setTimeout(redraw, 0);
  }

  return el('div', { class: 'screen' }, [
    el('h1', {}, t('filterTitle')),
    canvas,
    chips,
    confirmBtn,
  ]);
}

function filterLabel(id) {
  const map = {
    none: t('filterNone'),
    warm: t('filterWarm'),
    cool: t('filterCool'),
    bw: t('filterBw'),
    vintage: t('filterVintage'),
    vivid: t('filterVivid'),
  };
  return map[id] || id;
}

const MIN_PRINT_QUANTITY = 1;
const FALLBACK_MAX_PRINT_QUANTITY = 10;

function renderQr(state) {
  // Payment (if any) already happened up front, before capture — see
  // state.js/renderQuantity/renderPayment. Nothing print-related left to do
  // here; the print job itself auto-enqueues once print.jpg is saved.
  const children = [
    el('h1', {}, t('qrTitle')),
    el('p', {}, t('qrSubtitle')),
    el('div', { class: 'qr-box' }, [el('img', { src: state.qrDataUrl, alt: 'QR' })]),
    el('button', { class: 'primary big-button', onclick: () => sendAction('restart') }, t('restartButton')),
  ];
  return el('div', { class: 'screen' }, children);
}

function formatEuros(cents) {
  return `€${(cents / 100).toFixed(2)}`;
}

function totalCentsFor(quantity, printSettings) {
  // quantity 0 means "QR only, no physical print" (2026-08-10 QR payment
  // gate) — its price is qrUnitPriceCents alone, never quantity*unitPrice
  // (which would be 0). Mirrors server/state.js's confirmPrintPayment.
  const unitPriceCents = (printSettings && printSettings.printUnitPriceCents) || 0;
  const qrUnitPriceCents = (printSettings && printSettings.qrUnitPriceCents) || 0;
  const qrRequiresPayment = Boolean(printSettings && printSettings.qrRequiresPayment);
  if (quantity > 0) return quantity * unitPriceCents + (qrRequiresPayment ? qrUnitPriceCents : 0);
  return qrUnitPriceCents;
}

function renderQuantity(state) {
  const printOrder = state.printOrder;
  const quantity = printOrder ? printOrder.quantity : MIN_PRINT_QUANTITY;
  const maxQuantity = (printSettingsCache && printSettingsCache.maxPrintQuantity) || FALLBACK_MAX_PRINT_QUANTITY;
  // 0장(QR만)은 qrRequiresPayment가 켜져 있을 때만 선택 가능 — 그 외엔 기존처럼 최소 1장.
  const minQuantity = (printSettingsCache && printSettingsCache.qrRequiresPayment) ? 0 : MIN_PRINT_QUANTITY;
  const totalLabel = printSettingsCache
    ? t('quantityTotal', { total: formatEuros(totalCentsFor(quantity, printSettingsCache)) })
    : t('quantityOf', { quantity });

  return el('div', { class: 'screen' }, [
    el('h1', {}, t('quantityTitle')),
    el('div', { style: 'display:flex;align-items:center;gap:16px;justify-content:center;' }, [
      el(
        'button',
        {
          disabled: quantity <= minQuantity ? 'disabled' : null,
          onclick: () => sendAction('setPrintQuantity', { quantity: quantity - 1 }),
        },
        '-',
      ),
      el('div', {}, quantity === 0 ? t('quantityQrOnly') : t('quantityOf', { quantity })),
      el(
        'button',
        {
          disabled: quantity >= maxQuantity ? 'disabled' : null,
          onclick: () => sendAction('setPrintQuantity', { quantity: quantity + 1 }),
        },
        '+',
      ),
    ]),
    el('div', { class: 'progress-text' }, totalLabel),
    el('div', { style: 'display:flex;gap:16px;justify-content:center;' }, [
      el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
      el(
        'button',
        { class: 'primary big-button', onclick: () => sendAction('confirmPrintQuantity') },
        t('quantityConfirmButton'),
      ),
    ]),
  ]);
}

function renderPayment(state) {
  const printOrder = state.printOrder;
  const quantity = printOrder ? printOrder.quantity : MIN_PRINT_QUANTITY;
  const totalLabel = printSettingsCache
    ? t('paymentTotalLabel', { total: formatEuros(totalCentsFor(quantity, printSettingsCache)) })
    : t('quantityOf', { quantity });

  const methodBtn = (method, label) =>
    el(
      'button',
      {
        class: state.paymentMethod === method ? 'primary' : null,
        onclick: () => sendAction('choosePaymentMethod', { method }),
      },
      label,
    );

  const children = [
    el('h1', {}, t('paymentTitle')),
    el('div', {}, totalLabel),
    el('div', { style: 'display:flex;gap:16px;justify-content:center;' }, [
      methodBtn('sumup', t('paymentMethodSumup')),
      methodBtn('cash', t('paymentMethodCash')),
    ]),
  ];

  if (state.paymentMethod) {
    children.push(el('div', {}, t('paymentAwaiting')));
  }

  children.push(
    el('div', { style: 'display:flex;gap:16px;justify-content:center;' }, [
      // 'cancel'은 state.js에서 이미 PAYMENT 단계까지 허용돼 있었지만(테스트/취소 목적)
      // 이 화면엔 버튼이 없었음(2026-08-11) — 세션을 완전히 처음으로 되돌린다(수량 화면으로만
      // 돌아가는 backToQuantity와 다름).
      el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
      el('button', { onclick: () => sendAction('backToQuantity') }, t('paymentBackButton')),
      // Staff-operated: this booth screen sits with staff at this step, same
      // as the rest of the flow (no separate staff-vs-customer surface exists
      // elsewhere in control.js either).
      el(
        'button',
        {
          class: 'primary big-button',
          disabled: state.paymentMethod ? null : 'disabled',
          onclick: () => sendAction('confirmPrintPayment'),
        },
        t('paymentConfirmButton'),
      ),
    ]),
  );

  return el('div', { class: 'screen' }, children);
}
