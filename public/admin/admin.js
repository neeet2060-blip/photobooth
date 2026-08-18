import { t, mountLangToggle } from '../shared/i18n.js';

mountLangToggle(document.body, () => {
  applyStaticLabels();
});

const tabs = document.querySelectorAll('.tabs button');
const panels = {
  frames: document.getElementById('panel-frames'),
  settings: document.getElementById('panel-settings'),
  stats: document.getElementById('panel-stats'),
  printSettings: document.getElementById('panel-printSettings'),
  printQueue: document.getElementById('panel-printQueue'),
  printSettlement: document.getElementById('panel-printSettlement'),
  cloud: document.getElementById('panel-cloud'),
};

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    panels[btn.dataset.tab].classList.add('active');
    if (btn.dataset.tab === 'stats') loadStats();
    if (btn.dataset.tab === 'settings') loadSettings();
    if (btn.dataset.tab === 'printSettings') loadPrintSettings();
    if (btn.dataset.tab === 'printQueue') loadPrintQueue();
    if (btn.dataset.tab === 'printSettlement') loadPrintSettlement();
    if (btn.dataset.tab === 'cloud') loadCloudStatus();
  });
});

function applyStaticLabels() {
  tabs.forEach((btn) => {
    const labelKey = {
      frames: 'adminFrames',
      settings: 'adminSettings',
      stats: 'adminStats',
      printSettings: 'adminPrintSettings',
      printQueue: 'adminPrintQueue',
      printSettlement: 'adminPrintSettlement',
      cloud: 'adminCloud',
    }[btn.dataset.tab];
    btn.textContent = t(labelKey);
  });
  document.getElementById('frame-upload-btn').textContent = t('adminUpload');
  document.getElementById('settings-save-btn').textContent = t('adminSave');
  document.getElementById('print-settings-save-btn').textContent = t('adminSave');
}

applyStaticLabels();

// ---- Frames panel ----

async function loadFrames() {
  const res = await fetch('/api/admin/frames');
  const data = await res.json();
  renderFrameList(data.frames || []);
}

function renderFrameList(frames) {
  const list = document.getElementById('frame-list');
  list.innerHTML = '';
  const sorted = [...frames].sort((a, b) => a.order - b.order);
  for (const frame of sorted) {
    const row = document.createElement('div');
    row.className = 'frame-row';

    const img = document.createElement('img');
    img.src = frame.file;
    row.appendChild(img);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${frame.name} (${frame.layout})`;
    row.appendChild(name);

    const activeBtn = document.createElement('button');
    activeBtn.textContent = frame.active ? t('adminActive') : t('adminInactive');
    activeBtn.addEventListener('click', () => updateFrame(frame.id, { active: !frame.active }));
    row.appendChild(activeBtn);

    const upBtn = document.createElement('button');
    upBtn.textContent = t('adminMoveUp');
    upBtn.addEventListener('click', () => updateFrame(frame.id, { move: 'up' }));
    row.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.textContent = t('adminMoveDown');
    downBtn.addEventListener('click', () => updateFrame(frame.id, { move: 'down' }));
    row.appendChild(downBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = t('adminDelete');
    delBtn.addEventListener('click', () => deleteFrame(frame.id));
    row.appendChild(delBtn);

    list.appendChild(row);
  }
}

async function updateFrame(id, patch) {
  await fetch(`/api/admin/frames/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  loadFrames();
}

async function deleteFrame(id) {
  await fetch(`/api/admin/frames/${id}`, { method: 'DELETE' });
  loadFrames();
}

document.getElementById('frame-upload-btn').addEventListener('click', async () => {
  const name = document.getElementById('frame-name').value.trim();
  const layout = document.getElementById('frame-layout').value;
  const fileInput = document.getElementById('frame-file');
  const file = fileInput.files[0];
  if (!file) {
    alert('파일을 선택하세요');
    return;
  }
  const formData = new FormData();
  formData.append('name', name || 'Untitled');
  formData.append('layout', layout);
  formData.append('file', file);
  const res = await fetch('/api/admin/frames', { method: 'POST', body: formData });
  if (res.ok) {
    document.getElementById('frame-name').value = '';
    fileInput.value = '';
    loadFrames();
  } else {
    alert(t('errorGeneric'));
  }
});

// ---- Settings panel ----

const SETTINGS_FIELDS = [
  { key: 'shotsTotal', label: '총 촬영 수', type: 'number' },
  { key: 'countdownSeconds', label: '카운트다운(초)', type: 'number' },
  { key: 'idleTimeoutSec', label: '유휴 타임아웃(초)', type: 'number' },
  { key: 'qrTimeoutSec', label: 'QR 화면 타임아웃(초)', type: 'number' },
  { key: 'autoDeleteHours', label: '자동 삭제(시간)', type: 'number' },
  { key: 'cloudUploadTimeoutMs', label: '클라우드 업로드 제한시간(ms)', type: 'number' },
  {
    key: 'firebaseStorageBucket',
    label: 'Firebase Storage 버킷 (비워두면 클라우드 QR 비활성)',
    type: 'text',
  },
  { key: 'defaultLang', label: '기본 언어', type: 'select', options: ['ko', 'en'] },
];

async function loadSettings() {
  const res = await fetch('/api/admin/settings');
  const data = await res.json();
  renderSettingsForm(data.settings || {});
}

function renderSettingsForm(settings) {
  const form = document.getElementById('settings-form');
  form.innerHTML = '';
  for (const field of SETTINGS_FIELDS) {
    const row = document.createElement('div');
    row.className = 'form-row';

    const label = document.createElement('label');
    label.textContent = field.label;
    row.appendChild(label);

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const opt of field.options) {
        const optEl = document.createElement('option');
        optEl.value = opt;
        optEl.textContent = opt;
        input.appendChild(optEl);
      }
      input.value = settings[field.key];
    } else if (field.type === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = settings[field.key] || '';
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.value = settings[field.key];
    }
    input.dataset.key = field.key;
    row.appendChild(input);
    form.appendChild(row);
  }
}

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const inputs = document.querySelectorAll('#settings-form [data-key]');
  const payload = {};
  inputs.forEach((input) => {
    payload[input.dataset.key] = input.value;
  });
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    loadSettings();
  } else {
    alert(t('errorGeneric'));
  }
});

// ---- Stats panel ----

async function loadStats() {
  const res = await fetch('/api/admin/stats');
  const data = await res.json();
  renderStats(data.stats || {});
}

function renderStats(stats) {
  const cards = document.getElementById('stat-cards');
  cards.innerHTML = '';
  const entries = [
    ['완료된 세션', stats.sessionsCompleted || 0],
    ['시작된 세션', stats.sessionsStarted || 0],
    ['오늘 세션', stats.sessionsToday || 0],
    ['완료율', `${stats.completionRate || 0}%`],
  ];
  for (const [label, value] of entries) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="value">${value}</div><div>${label}</div>`;
    cards.appendChild(card);
  }

  renderUsageTable('frame-usage-table', stats.frameUsage || {});
  renderUsageTable('filter-usage-table', stats.filterUsage || {});
}

function renderUsageTable(elementId, usageMap) {
  const table = document.getElementById(elementId);
  table.innerHTML = '';
  const header = document.createElement('tr');
  header.innerHTML = '<th>ID</th><th>횟수</th>';
  table.appendChild(header);
  const entries = Object.entries(usageMap);
  if (entries.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="2">데이터 없음</td>';
    table.appendChild(row);
    return;
  }
  for (const [key, count] of entries) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${key}</td><td>${count}</td>`;
    table.appendChild(row);
  }
}

// ---- Print settings panel ----

const PRINT_SETTINGS_FIELDS = [
  { key: 'printingEnabled', label: '인화 기능 사용 (끄면 방문객 화면에서 인화 버튼이 사라짐)', type: 'checkbox' },
  { key: 'printUnitPriceCents', label: '인화 단가 (EUR)', type: 'price' },
  { key: 'maxPrintQuantity', label: '최대 인화 매수', type: 'number' },
  { key: 'printMode', label: '인쇄 모드', type: 'select', options: ['folder', 'cups', 'windows', 'ipp'] },
  { key: 'printerName', label: '프린터 이름 (cups/windows 모드)', type: 'text' },
  { key: 'printerUrl', label: '프린터 주소 (ipp 모드, 비워두면 자동탐색 — 권장)', type: 'text' },
  { key: 'printMedia', label: '용지 크기', type: 'text' },
  { key: 'qrRequiresPayment', label: 'QR 다운로드 결제 필요 (켜면 결제 전엔 QR 화면이 막힘)', type: 'checkbox' },
  { key: 'qrUnitPriceCents', label: 'QR 다운로드 단가 (EUR)', type: 'price' },
];

async function loadPrintSettings() {
  const res = await fetch('/api/admin/settings');
  const data = await res.json();
  renderPrintSettingsForm(data.settings || {});
}

function renderPrintSettingsForm(settings) {
  const form = document.getElementById('print-settings-form');
  form.innerHTML = '';
  for (const field of PRINT_SETTINGS_FIELDS) {
    const row = document.createElement('div');
    row.className = 'form-row';

    const label = document.createElement('label');
    label.textContent = field.label;
    row.appendChild(label);

    let input;
    if (field.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings[field.key] !== false;
    } else if (field.type === 'select') {
      input = document.createElement('select');
      for (const opt of field.options) {
        const optEl = document.createElement('option');
        optEl.value = opt;
        optEl.textContent = opt;
        input.appendChild(optEl);
      }
      input.value = settings[field.key];
    } else if (field.type === 'price') {
      // Cents <-> euros conversion happens only at this UI boundary.
      input = document.createElement('input');
      input.type = 'number';
      input.min = '0.01';
      input.step = '0.01';
      input.value = ((settings[field.key] || 0) / 100).toFixed(2);
    } else if (field.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.value = settings[field.key];
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = settings[field.key] || '';
    }
    input.dataset.key = field.key;
    input.dataset.type = field.type;
    row.appendChild(input);
    form.appendChild(row);
  }
}

document.getElementById('print-settings-save-btn').addEventListener('click', async () => {
  const inputs = document.querySelectorAll('#print-settings-form [data-key]');
  const payload = {};
  inputs.forEach((input) => {
    if (input.dataset.type === 'checkbox') {
      payload[input.dataset.key] = input.checked;
    } else if (input.dataset.type === 'price') {
      payload[input.dataset.key] = Math.round(Number(input.value) * 100);
    } else {
      payload[input.dataset.key] = input.value;
    }
  });
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    loadPrintSettings();
  } else {
    alert(t('errorGeneric'));
  }
});

// ---- Print queue panel ----

let printQueueSocket = null;

function ensurePrintQueueSocket() {
  if (printQueueSocket) return printQueueSocket;
  printQueueSocket = window.io({ secure: true, transports: ['websocket', 'polling'] });
  printQueueSocket.on('print-queue', (jobs) => {
    renderPrintQueue(jobs || []);
  });
  return printQueueSocket;
}

async function loadPrintQueue() {
  ensurePrintQueueSocket();
  const res = await fetch('/api/admin/printqueue');
  const data = await res.json();
  renderPrintQueue(data.jobs || []);
}

function renderPrintQueue(jobs) {
  const list = document.getElementById('print-queue-list');
  list.innerHTML = '';
  if (jobs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = t('adminPrintNoJobs');
    list.appendChild(empty);
    return;
  }
  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  for (const job of sorted) {
    const row = document.createElement('div');
    row.className = 'frame-row';

    const info = document.createElement('div');
    info.className = 'name';
    const amount = (job.totalCents / 100).toFixed(2);
    info.textContent = `[${printStatusLabel(job)}] ${job.quantity}장 · €${amount} · ${new Date(job.createdAt).toLocaleString('ko-KR')}`;
    row.appendChild(info);

    if (job.status === 'failed') {
      const retryBtn = document.createElement('button');
      retryBtn.textContent = t('adminPrintRetry');
      retryBtn.addEventListener('click', () => retryPrintJob(job.id));
      row.appendChild(retryBtn);
    }
    if (job.status === 'queued') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'danger';
      cancelBtn.textContent = t('adminPrintCancel');
      cancelBtn.addEventListener('click', () => cancelPrintJob(job.id));
      row.appendChild(cancelBtn);
    }

    list.appendChild(row);
  }
}

async function retryPrintJob(id) {
  await fetch(`/api/admin/printqueue/${id}/retry`, { method: 'POST' });
  loadPrintQueue();
}

async function cancelPrintJob(id) {
  await fetch(`/api/admin/printqueue/${id}/cancel`, { method: 'POST' });
  loadPrintQueue();
}

// ---- Print settlement panel ----

async function loadPrintSettlement() {
  const res = await fetch('/api/admin/printsettlement');
  const data = await res.json();
  renderPrintSettlement(data);
}

function renderPrintSettlement(data) {
  const cards = document.getElementById('print-settlement-cards');
  cards.innerHTML = '';
  const entries = [
    [t('adminPrintTotalSold'), data.totalPrintsSold || 0],
    [t('adminPrintTotalRevenue'), `€${((data.totalRevenueCents || 0) / 100).toFixed(2)}`],
  ];
  for (const [label, value] of entries) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="value">${value}</div><div>${label}</div>`;
    cards.appendChild(card);
  }

  document.getElementById('print-by-day-title').textContent = t('adminPrintByDay');
  document.getElementById('print-by-hour-title').textContent = t('adminPrintByHour');
  document.getElementById('print-orders-title').textContent = t('adminPrintOrders');

  renderByBucketTable('print-by-day-table', data.byDay || {});
  renderByBucketTable('print-by-hour-table', data.byHour || {});
  renderOrdersTable(data.orders || []);
}

function renderByBucketTable(elementId, bucketMap) {
  const table = document.getElementById(elementId);
  table.innerHTML = '';
  const header = document.createElement('tr');
  header.innerHTML = '<th>구간</th><th>매수</th><th>매출</th>';
  table.appendChild(header);
  const entries = Object.entries(bucketMap);
  if (entries.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="3">데이터 없음</td>';
    table.appendChild(row);
    return;
  }
  for (const [key, bucket] of entries) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${key}</td><td>${bucket.quantity}</td><td>€${(bucket.revenueCents / 100).toFixed(2)}</td>`;
    table.appendChild(row);
  }
}

function renderOrdersTable(orders) {
  const table = document.getElementById('print-orders-table');
  table.innerHTML = '';
  const header = document.createElement('tr');
  header.innerHTML = '<th>ID</th><th>시간</th><th>세션</th><th>매수</th><th>금액</th><th>상태</th>';
  table.appendChild(header);
  if (orders.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="6">데이터 없음</td>';
    table.appendChild(row);
    return;
  }
  for (const order of orders) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${order.id}</td><td>${new Date(order.createdAt).toLocaleString('ko-KR')}</td><td>${order.sessionId}</td><td>${order.quantity}</td><td>€${(order.totalCents / 100).toFixed(2)}</td><td>${printStatusLabel(order)}</td>`;
    table.appendChild(row);
  }
}

const PRINT_STATUS_LABELS = {
  queued: '대기중',
  printing: '인쇄중',
  failed: '실패',
  canceled: '취소됨',
};

/**
 * Human label for a print job's status.
 *
 * 'done' is deliberately never shown as "완료/출력됨": in folder mode nothing
 * was printed at all, and in cups mode the file was only handed to the print
 * system — neither is proof that paper actually came out. Staff must check the
 * physical printer, especially since the visitor has already paid.
 */
function printStatusLabel(job) {
  if (job.status !== 'done') {
    return PRINT_STATUS_LABELS[job.status] || job.status;
  }
  if (job.mode === 'cups') return '프린터로 전송됨';
  if (job.mode === 'folder') return '파일 저장됨';
  return '처리됨';
}

// ---- Cloud delivery status panel (read-only) ----

async function loadCloudStatus() {
  const res = await fetch('/api/admin/cloud');
  const data = await res.json();
  renderCloudStatus(data);
}

function renderCloudStatus(data) {
  const cards = document.getElementById('cloud-status-cards');
  cards.innerHTML = '';
  const entries = [
    [t('adminCloud'), data.enabled ? t('adminCloudStatusEnabled') : t('adminCloudStatusDisabled')],
    [t('adminCloudBucket'), data.bucket || t('adminCloudBucketNone')],
    [t('adminCloudUploadTimeout'), data.uploadTimeoutMs != null ? data.uploadTimeoutMs : '-'],
    [t('adminCloudDelivered'), data.cloudDeliveredCount || 0],
    [t('adminCloudLanFallback'), data.lanFallbackCount || 0],
  ];
  for (const [label, value] of entries) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="value">${value}</div><div>${label}</div>`;
    cards.appendChild(card);
  }
}

loadFrames();
loadSettings();
