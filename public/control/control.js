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

const FORMAT_LABEL_KEYS = {
  strip: 'formatOptionStrip', grid: 'formatOptionGrid',
  grid2a: 'formatOptionGrid2a', grid2b: 'formatOptionGrid2b',
};

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
  return el('div', { class: 'screen' }, [
    el('h1', {}, t('formatTitle')),
    grid,
    el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
  ]);
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
  return el('div', { class: 'screen' }, [
    el('h1', {}, t('themeTitle')),
    grid,
    el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
  ]);
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

  // 촬영 중에도 처음 화면으로 돌아갈 수 있어야 함(2026-08-11 사용자 요청) — state.js의 'cancel'이
  // 이미 CAPTURE 단계까지 허용하도록 확장됨; 세션 abandon 처리(사진 삭제)까지 기존 로직 그대로 재사용.
  // 이미 결제가 끝난 세션(confirmedPrintOrder 또는 qrPaid)이면 취소가 곧 "받은 돈을 그냥 버림"이므로
  // (환불 로직이 따로 없음), 실수로 누르는 걸 막기 위해 한 번 더 확인한다.
  children.push(
    el(
      'button',
      {
        onclick: () => {
          const alreadyPaid = Boolean(state.confirmedPrintOrder) || state.qrPaid === true;
          if (alreadyPaid && !window.confirm(t('cancelPaidConfirmMsg'))) return;
          sendAction('cancel');
        },
      },
      t('cancelButton'),
    ),
  );

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

  // 2026-08-11 pre-launch audit finding: composeFrame() is async (loads 4
  // photos + the frame image) and its failure/still-pending state was never
  // surfaced — the confirm button stayed clickable throughout, so a slow
  // load or a failed image (404, CORS) could submit a black/partial canvas
  // as the customer's permanent final photo with no error to anyone. The
  // button now starts disabled and only re-enables once a composite
  // actually finishes successfully; a failure keeps it disabled and alerts
  // instead of silently letting a bad photo through.
  let composeReady = false;
  const redraw = () => {
    if (!frame) return;
    composeReady = false;
    confirmBtn.disabled = true;
    const activeFilter = filters.find((f) => f.id === state.filterId) || filters[0];
    composeFrame({
      canvas,
      layoutName: frame.layout,
      photoUrls: orderedPhotoUrls,
      frameUrl: frame.file,
      filterCss: activeFilter.css,
    }).then(() => {
      composeReady = true;
      confirmBtn.disabled = false;
    }).catch(() => {
      alert(t('composeFailedMsg'));
    });
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
    { class: 'primary big-button', disabled: 'disabled' },
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

// 이 QUANTITY phase에 처음 들어왔을 때 "QR vs 실제인쇄" 중 뭘 골랐는지는 서버 상태(printOrder)
// 로는 표현되지 않는 순수 화면 단계라 클라이언트 로컬로 따로 들고 있는다(2026-08-11). 세션이
// 바뀌면(재시작·새 손님) 자동으로 선택 화면으로 초기화된다.
let quantityScreenStep = 'choose'; // 'choose' | 'count'
let quantityScreenSessionId = null;

function renderQuantity(state) {
  if (quantityScreenSessionId !== state.sessionId) {
    quantityScreenSessionId = state.sessionId;
    quantityScreenStep = 'choose';
  }

  const printOrder = state.printOrder;
  const quantity = printOrder ? printOrder.quantity : MIN_PRINT_QUANTITY;
  const qrRequiresPayment = Boolean(printSettingsCache && printSettingsCache.qrRequiresPayment);
  const qrUnitPriceCents = (printSettingsCache && printSettingsCache.qrUnitPriceCents) || 0;
  const printingEnabled = Boolean(printSettingsCache && printSettingsCache.printingEnabled);

  if (quantityScreenStep === 'choose') {
    const qrPriceLabel = qrRequiresPayment ? formatEuros(qrUnitPriceCents) : t('quantityFreeLabel');
    const printPriceLabel = printSettingsCache
      ? t('quantityChoicePrintFrom', { price: formatEuros(totalCentsFor(MIN_PRINT_QUANTITY, printSettingsCache)) })
      : '';
    // 2026-08-11 pre-launch audit findings:
    // - The QR card was always shown labeled "무료" (free) and always sent
    //   quantity:0 — but the server only accepts quantity:0 when
    //   qrRequiresPayment is on (state.js's setPrintQuantity). With
    //   qrRequiresPayment off, that request was silently rejected and
    //   printOrder.quantity stayed at whatever it already was (1, once
    //   printingEnabled is on) — so confirmPrintQuantity right after it
    //   landed the customer on a real, unwanted print charge instead of the
    //   "free" QR they tapped. When qrRequiresPayment is off, the QR is
    //   delivered unconditionally regardless of this screen (see state.js's
    //   printOrder/qrPaid comments), so this card has nothing to offer in
    //   that config — only show it when qrRequiresPayment is genuinely on.
    // - The print card was always shown even when printingEnabled was off,
    //   letting a customer pay for prints the booth can no longer produce
    //   (e.g. printer taken offline mid-event). Only show it when enabled.
    // chooseTheme only ever routes here when printingEnabled||qrRequiresPayment,
    // so at least one of the two is always true — never a dead end.
    const cards = [];
    if (qrRequiresPayment) {
      cards.push(el(
        'button',
        {
          class: 'choice-card',
          onclick: () => {
            // QR만 — 매수 조정 화면 없이 곧장 0으로 확정하고 결제로 진행.
            sendAction('setPrintQuantity', { quantity: 0 });
            sendAction('confirmPrintQuantity');
          },
        },
        [el('div', {}, t('quantityChoiceQr')), el('div', {}, qrPriceLabel)],
      ));
    }
    if (printingEnabled) {
      cards.push(el(
        'button',
        {
          class: 'choice-card',
          onclick: () => {
            if (!printOrder || printOrder.quantity < MIN_PRINT_QUANTITY) {
              sendAction('setPrintQuantity', { quantity: MIN_PRINT_QUANTITY });
            }
            quantityScreenStep = 'count';
            render(lastState);
          },
        },
        [el('div', {}, t('quantityChoicePrint')), el('div', {}, printPriceLabel)],
      ));
    }
    return el('div', { class: 'screen' }, [
      el('h1', {}, t('quantityChoiceTitle')),
      el('div', { style: 'display:flex;gap:16px;justify-content:center;flex-wrap:wrap;' }, cards),
      el('div', { style: 'display:flex;gap:16px;justify-content:center;' }, [
        el('button', { onclick: () => sendAction('cancel') }, t('cancelButton')),
      ]),
    ]);
  }

  // step === 'count': 실제인쇄를 고른 뒤에만 오는, 기존 매수 조정 화면(0으로는 못 내려감 — QR은
  // 위 선택 화면에서 이미 별도로 처리됨).
  const maxQuantity = (printSettingsCache && printSettingsCache.maxPrintQuantity) || FALLBACK_MAX_PRINT_QUANTITY;
  const totalLabel = printSettingsCache
    ? t('quantityTotal', { total: formatEuros(totalCentsFor(quantity, printSettingsCache)) })
    : t('quantityOf', { quantity });

  return el('div', { class: 'screen' }, [
    el('h1', {}, t('quantityTitle')),
    el('div', { style: 'display:flex;align-items:center;gap:16px;justify-content:center;' }, [
      el(
        'button',
        {
          disabled: quantity <= MIN_PRINT_QUANTITY ? 'disabled' : null,
          onclick: () => sendAction('setPrintQuantity', { quantity: quantity - 1 }),
        },
        '-',
      ),
      el('div', {}, t('quantityOf', { quantity })),
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
      el('button', { onclick: () => { quantityScreenStep = 'choose'; render(lastState); } }, t('quantityBackButton')),
      el(
        'button',
        { class: 'primary big-button', onclick: () => sendAction('confirmPrintQuantity') },
        t('quantityConfirmButton'),
      ),
    ]),
  ]);
}

// Local-only UI flag (not dispatched state): set once the participant has
// clicked confirm, so renderPayment can show a "waiting on staff" message
// instead of leaving the click looking like a no-op. Reset implicitly by
// comparing against state.sessionId in renderPayment, same pattern as
// quantityScreenSessionId above.
let paymentConfirmedSessionId = null;

// Real auto-confirmation (2026-08-11, TOK2026 integration): clicking confirm
// must NOT itself finalize payment locally, for either method — that
// decision belongs to TOK2026's existing confirmation system (SumUp
// transaction match for card, staff tapping "confirm" on the exp1
// pending-orders screen for cash). The server's background tokPayment.js
// poll (already running since the order was created) is what actually
// dispatches confirmPrintPayment, once TOK2026 reports paymentStatus:"paid".
//
// Card payments are NOT opened here: this control screen runs on a tablet,
// and SumUp Tap to Pay only works from a phone — so the actual SumUp deep
// link is opened from TOK2026's own exp1 admin screen on the real payment
// phone (see ExpPosPage.jsx's payCardForPendingOrder), which already shows
// this order the moment it's created. This button's job is just to signal
// "confirmed, staff can proceed" and then wait.
//
// Only when the TOK2026 bridge isn't configured for this event at all is
// there no auto-confirm to wait for, so this falls back to the
// pre-integration behavior of dispatching confirmPrintPayment immediately.
async function handlePaymentConfirm(state) {
  // 2026-08-11 pre-launch audit finding: previously, ANY fetch failure
  // (a transient network blip, not just "bridge genuinely not configured")
  // fell through to the same instant-confirm-for-free branch as a real
  // disabled bridge — a momentary Wi-Fi hiccup at the exact moment staff
  // clicked confirm would mark the order paid with no actual payment
  // confirmation from TOK2026. Distinguish the two: only a successful check
  // that comes back {enabled:false} counts as "no bridge, confirm locally."
  // A failed check is 'unknown' and must never silently confirm.
  let status; // 'enabled' | 'disabled' | 'unknown'
  try {
    const res = await fetch('/api/tok-payment-status');
    const data = await res.json();
    status = (data && data.enabled) ? 'enabled' : 'disabled';
  } catch (err) {
    status = 'unknown';
  }

  if (status === 'unknown') {
    alert(t('paymentStatusCheckFailedMsg'));
    return;
  }

  if (status === 'disabled') {
    sendAction('confirmPrintPayment');
    return;
  }

  // This click doesn't change any dispatched state, so re-render locally to
  // swap in the "waiting on staff" message below (renderPayment).
  paymentConfirmedSessionId = state.sessionId;
  render(lastState);
}

function renderPayment(state) {
  const printOrder = state.printOrder;
  const quantity = printOrder ? printOrder.quantity : MIN_PRINT_QUANTITY;
  const totalLabel = printSettingsCache
    ? t('paymentTotalLabel', { total: formatEuros(totalCentsFor(quantity, printSettingsCache)) })
    : t('quantityOf', { quantity });
  // 결제요청(카드/현금 버튼 클릭)을 누른 시각(2026-08-11 사용자 요청/수정) — TOK2026 결제
  // 대시보드엔 여러 미결제건이 동시에 뜰 수 있어서, 직원이 "지금 이 손님" 주문을 시각으로 맞춰
  // 찾은 뒤 그 화면의 SumUp 버튼으로 결제를 시도한다. paymentMethodChosenAt은 'choosePaymentMethod'
  // 시점에 찍히는데, 이 시점이 곧 tokPayment.js가 TOK2026 주문을 만들거나 동기화하는 시점과
  // 같아서(state.js 참고) 세션 시작 시각(createdAt)보다 훨씬 더 정확하게 대시보드 항목과 맞아떨어진다.
  const createdTimeLabel = state.paymentMethodChosenAt
    ? t('paymentCreatedAtLabel', { time: new Date(state.paymentMethodChosenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : null;

  const methodBtn = (method, label) =>
    el(
      'button',
      {
        class: state.paymentMethod === method ? 'primary' : null,
        onclick: () => {
          // A fresh method choice (even re-choosing the same method after
          // switching away) always clears a prior "waiting on staff" flag —
          // otherwise switching cash -> card -> cash again would show that
          // state without the participant having clicked confirm again.
          paymentConfirmedSessionId = null;
          sendAction('choosePaymentMethod', { method });
        },
      },
      label,
    );

  const children = [
    el('h1', {}, t('paymentTitle')),
    el('div', {}, totalLabel),
  ];
  if (createdTimeLabel) {
    children.push(el('div', { style: 'color:var(--muted, #888);font-size:14px;' }, createdTimeLabel));
  }
  children.push(
    el('div', { style: 'display:flex;gap:16px;justify-content:center;' }, [
      methodBtn('sumup', t('paymentMethodSumup')),
      methodBtn('cash', t('paymentMethodCash')),
    ]),
  );

  const confirmed = Boolean(state.paymentMethod) && paymentConfirmedSessionId === state.sessionId;

  if (state.paymentMethod) {
    children.push(el('div', {}, confirmed ? t('paymentAwaitingStaffConfirm') : t('paymentAwaiting')));
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
          disabled: (state.paymentMethod && !confirmed) ? null : 'disabled',
          onclick: () => handlePaymentConfirm(state),
        },
        t('paymentConfirmButton'),
      ),
    ]),
  );

  return el('div', { class: 'screen' }, children);
}
