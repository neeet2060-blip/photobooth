import { t, mountLangToggle } from '../shared/i18n.js';

mountLangToggle(document.body, () => {
  applyStaticLabels();
});

const tabs = document.querySelectorAll('.tabs button');
const panels = {
  frames: document.getElementById('panel-frames'),
  settings: document.getElementById('panel-settings'),
  stats: document.getElementById('panel-stats'),
};

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    panels[btn.dataset.tab].classList.add('active');
    if (btn.dataset.tab === 'stats') loadStats();
    if (btn.dataset.tab === 'settings') loadSettings();
  });
});

function applyStaticLabels() {
  tabs.forEach((btn) => {
    const labelKey = { frames: 'adminFrames', settings: 'adminSettings', stats: 'adminStats' }[btn.dataset.tab];
    btn.textContent = t(labelKey);
  });
  document.getElementById('frame-upload-btn').textContent = t('adminUpload');
  document.getElementById('settings-save-btn').textContent = t('adminSave');
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

loadFrames();
loadSettings();
