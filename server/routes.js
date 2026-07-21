'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');

const store = require('./store');
const { PHASES, FILTERS } = require('./state');
const { getLanIp } = require('./ip');

const TOKEN_REGEX = /^[a-f0-9]{24}$/;
const FRAME_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_FRAME_MIME = new Set(['image/svg+xml', 'image/png']);

function isValidIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < 10000;
}

function fileFilterFactory(allowedMimes) {
  return (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      cb(new Error('unsupported_file_type'));
      return;
    }
    cb(null, true);
  };
}

/**
 * Registers all HTTP routes on the given Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   getState: () => object,
 *   dispatch: (action: object) => void,
 *   port: number,
 * }} deps
 */
function registerRoutes(app, deps) {
  const { getState, dispatch, port } = deps;

  // In-memory token -> sessionId map, persisted to disk so links survive restarts.
  const tokensFile = path.join(store.DATA_DIR, 'tokens.json');
  let tokens = store.readJsonFile(tokensFile, {});

  function saveTokens() {
    store.writeJsonFile(tokensFile, tokens);
  }

  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sessionId = req.body.sessionId;
        if (typeof sessionId !== 'string' || !/^[a-z0-9]{6,40}$/.test(sessionId)) {
          cb(new Error('invalid_session_id'));
          return;
        }
        const dir = path.join(store.PHOTOS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const index = Number(req.body.index);
        if (!isValidIndex(index)) {
          cb(new Error('invalid_index'));
          return;
        }
        cb(null, `${index}.jpg`);
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_PHOTO_MIME),
  });

  const finalUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sessionId = req.body.sessionId;
        if (typeof sessionId !== 'string' || !/^[a-z0-9]{6,40}$/.test(sessionId)) {
          cb(new Error('invalid_session_id'));
          return;
        }
        const dir = path.join(store.PHOTOS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, 'final.jpg'),
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_PHOTO_MIME),
  });

  const frameUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, store.FRAMES_DIR),
      filename: (req, file, cb) => {
        const ext = file.mimetype === 'image/svg+xml' ? 'svg' : 'png';
        cb(null, `${crypto.randomBytes(8).toString('hex')}.${ext}`);
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: fileFilterFactory(ALLOWED_FRAME_MIME),
  });

  // ---- Session photo upload ----

  app.post('/api/photos', photoUpload.single('photo'), (req, res) => {
    const state = getState();
    const sessionId = req.body.sessionId;
    const index = Number(req.body.index);

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    if (state.phase !== PHASES.CAPTURE) {
      return res.status(409).json({ ok: false, error: 'not_in_capture_phase' });
    }
    if (sessionId !== state.sessionId) {
      return res.status(409).json({ ok: false, error: 'session_mismatch' });
    }
    if (!isValidIndex(index) || index >= state.shotsTotal) {
      return res.status(400).json({ ok: false, error: 'invalid_index' });
    }
    if (state.photos.some((p) => p.index === index)) {
      return res.status(409).json({ ok: false, error: 'index_already_used' });
    }

    dispatch({ type: 'photoRecorded', payload: { index, file: `/photos/${sessionId}/${index}.jpg` } });
    return res.json({ ok: true });
  });

  // ---- Final composited image upload ----

  app.post('/api/final', finalUpload.single('photo'), (req, res) => {
    const state = getState();
    const sessionId = req.body.sessionId;

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    if (state.phase !== PHASES.FILTER) {
      return res.status(409).json({ ok: false, error: 'not_in_filter_phase' });
    }
    if (sessionId !== state.sessionId) {
      return res.status(409).json({ ok: false, error: 'session_mismatch' });
    }

    const token = crypto.randomBytes(12).toString('hex');
    tokens[token] = { sessionId, createdAt: Date.now() };
    saveTokens();

    const lanIp = getLanIp();
    const finalUrl = `https://${lanIp}:${port}/p/${token}`;

    QRCode.toDataURL(finalUrl, { margin: 1, width: 480 })
      .then((qrDataUrl) => {
        dispatch({ type: 'finalSaved', payload: { finalUrl, finalToken: token, qrDataUrl } });
        res.json({ ok: true, finalUrl, token });
      })
      .catch((err) => {
        res.status(500).json({ ok: false, error: 'qr_generation_failed', message: err.message });
      });
  });

  // ---- Visitor download page ----

  app.get('/p/:token', (req, res) => {
    const { token } = req.params;
    if (!TOKEN_REGEX.test(token)) {
      return res.status(404).send(renderNotFoundPage());
    }
    const entry = tokens[token];
    if (!entry) {
      return res.status(404).send(renderNotFoundPage());
    }
    const finalPath = path.join(store.PHOTOS_DIR, entry.sessionId, 'final.jpg');
    if (!fs.existsSync(finalPath)) {
      return res.status(404).send(renderNotFoundPage());
    }
    const settings = store.readSettings();
    return res.send(renderDownloadPage({
      imageSrc: `/photos/${entry.sessionId}/final.jpg`,
      autoDeleteHours: settings.autoDeleteHours,
    }));
  });

  // ---- Admin: frames ----

  app.get('/api/admin/frames', (req, res) => {
    res.json({ ok: true, frames: store.readFrames() });
  });

  app.post('/api/admin/frames', frameUpload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }
    const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : 'Untitled';
    const layout = req.body.layout === 'grid' ? 'grid' : req.body.layout === 'strip' ? 'strip' : null;
    if (!layout) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ ok: false, error: 'invalid_layout' });
    }
    const frames = store.readFrames();
    const id = crypto.randomBytes(6).toString('hex');
    const newFrame = {
      id,
      name,
      layout,
      file: `/frames/${req.file.filename}`,
      active: true,
      order: frames.length,
      createdAt: Date.now(),
    };
    const next = store.writeFrames([...frames, newFrame]);
    res.json({ ok: true, frames: next });
  });

  app.post('/api/admin/frames/:id', (req, res) => {
    const { id } = req.params;
    if (!FRAME_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const frames = store.readFrames();
    const idx = frames.findIndex((f) => f.id === id);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const patch = {};
    if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 80);
    if (typeof req.body.active === 'boolean') patch.active = req.body.active;
    if (req.body.move === 'up' || req.body.move === 'down') {
      const sorted = [...frames].sort((a, b) => a.order - b.order);
      const pos = sorted.findIndex((f) => f.id === id);
      const swapWith = req.body.move === 'up' ? pos - 1 : pos + 1;
      if (swapWith >= 0 && swapWith < sorted.length) {
        const a = sorted[pos];
        const b = sorted[swapWith];
        const orderA = a.order;
        sorted[pos] = { ...a, order: b.order };
        sorted[swapWith] = { ...b, order: orderA };
      }
      const next = store.writeFrames(sorted);
      return res.json({ ok: true, frames: next });
    }
    const next = [...frames];
    next[idx] = { ...next[idx], ...patch };
    const written = store.writeFrames(next);
    return res.json({ ok: true, frames: written });
  });

  app.delete('/api/admin/frames/:id', (req, res) => {
    const { id } = req.params;
    if (!FRAME_ID_REGEX.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    const frames = store.readFrames();
    const frame = frames.find((f) => f.id === id);
    if (!frame) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const next = frames.filter((f) => f.id !== id);
    store.writeFrames(next);
    if (frame.file && frame.file.startsWith('/frames/')) {
      const filePath = path.join(store.FRAMES_DIR, path.basename(frame.file));
      fs.unlink(filePath, () => {});
    }
    res.json({ ok: true, frames: next });
  });

  // ---- Admin: settings ----

  app.get('/api/admin/settings', (req, res) => {
    res.json({ ok: true, settings: store.readSettings() });
  });

  app.post('/api/admin/settings', (req, res) => {
    const body = req.body || {};
    const current = store.readSettings();
    const next = { ...current };

    const numericFields = ['shotsTotal', 'countdownSeconds', 'idleTimeoutSec', 'qrTimeoutSec', 'autoDeleteHours'];
    for (const field of numericFields) {
      if (body[field] !== undefined) {
        const num = Number(body[field]);
        if (!Number.isFinite(num) || num <= 0) {
          return res.status(400).json({ ok: false, error: `invalid_${field}` });
        }
        next[field] = Math.round(num);
      }
    }
    if (body.defaultLang !== undefined) {
      if (body.defaultLang !== 'ko' && body.defaultLang !== 'en') {
        return res.status(400).json({ ok: false, error: 'invalid_defaultLang' });
      }
      next.defaultLang = body.defaultLang;
    }

    const written = store.writeSettings(next);
    res.json({ ok: true, settings: written });
  });

  // ---- Admin: stats ----

  app.get('/api/admin/stats', (req, res) => {
    const stats = store.readStats();
    const completionRate = stats.sessionsStarted > 0
      ? Math.round((stats.sessionsCompleted / stats.sessionsStarted) * 1000) / 10
      : 0;
    res.json({ ok: true, stats: { ...stats, completionRate } });
  });

  // ---- Misc metadata for clients ----

  app.get('/api/frames', (req, res) => {
    const frames = store
      .readFrames()
      .filter((f) => f.active)
      .sort((a, b) => a.order - b.order);
    res.json({ ok: true, frames });
  });

  app.get('/api/filters', (req, res) => {
    res.json({ ok: true, filters: FILTERS });
  });

  app.get('/api/lan-info', (req, res) => {
    res.json({ ok: true, ip: getLanIp(), port });
  });

  // ---- Role pages: serve each role's index.html directly on the bare path ----
  // (without this, express.static would 301-redirect e.g. GET /control to
  // GET /control/ before serving the file, which breaks simple health checks
  // and is an unnecessary round trip for every client.)

  const ROLE_PAGES = ['control', 'camera', 'remote', 'display', 'admin'];
  for (const role of ROLE_PAGES) {
    app.get(`/${role}`, (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'public', role, 'index.html'));
    });
  }

  // ---- Home page: role links + QR codes ----

  app.get('/', async (req, res) => {
    const lanIp = getLanIp();
    const roles = [
      { path: '/control', label: '컨트롤 (태블릿)' },
      { path: '/camera', label: '카메라 (스마트폰)' },
      { path: '/remote', label: '리모컨' },
      { path: '/display', label: '디스플레이 (TV)' },
      { path: '/admin', label: '관리자' },
    ];

    try {
      const withQr = await Promise.all(
        roles.map(async (role) => {
          const url = `https://${lanIp}:${port}${role.path}`;
          const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
          return { ...role, url, qrDataUrl };
        }),
      );
      res.send(renderHomePage({ lanIp, port, roles: withQr }));
    } catch (err) {
      res.status(500).send('QR generation failed');
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHomePage({ lanIp, port, roles }) {
  const cards = roles
    .map(
      (role) => `
      <a class="role-card" href="${escapeHtml(role.url)}">
        <img src="${role.qrDataUrl}" alt="${escapeHtml(role.label)} QR" />
        <div class="role-label">${escapeHtml(role.label)}</div>
        <div class="role-url">${escapeHtml(role.url)}</div>
      </a>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>인생네컷 포토부스 - 설정</title>
  <link rel="stylesheet" href="/shared/app.css" />
  <style>
    .home { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
    .lan-banner { text-align: center; font-size: 1.4rem; margin-bottom: 24px; padding: 16px; border: 2px solid var(--accent); border-radius: 12px; }
    .roles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .role-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--surface); border-radius: 16px; text-decoration: none; color: inherit; }
    .role-card img { width: 160px; height: 160px; background: #fff; border-radius: 8px; }
    .role-label { font-weight: bold; font-size: 1.1rem; }
    .role-url { font-size: 0.8rem; opacity: 0.7; word-break: break-all; text-align: center; }
  </style>
</head>
<body>
  <div class="home">
    <h1>인생네컷 포토부스</h1>
    <div class="lan-banner">서버 주소: <strong>${escapeHtml(lanIp)}:${port}</strong></div>
    <div class="roles-grid">${cards}</div>
  </div>
</body>
</html>`;
}

function renderDownloadPage({ imageSrc, autoDeleteHours }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>내 사진 다운로드 - 인생네컷</title>
  <link rel="stylesheet" href="/shared/app.css" />
  <style>
    .download-page { max-width: 480px; margin: 0 auto; padding: 24px 16px; text-align: center; }
    .download-page img { width: 100%; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); margin-bottom: 24px; }
    .download-btn { display: inline-block; padding: 18px 36px; font-size: 1.3rem; font-weight: bold; background: var(--accent); color: #111; border-radius: 999px; text-decoration: none; }
    .privacy-note { margin-top: 20px; font-size: 0.9rem; opacity: 0.7; }
  </style>
</head>
<body>
  <div class="download-page">
    <h1>내 사진</h1>
    <img src="${escapeHtml(imageSrc)}" alt="최종 사진" />
    <a class="download-btn" href="${escapeHtml(imageSrc)}" download="my-photobooth.jpg">다운로드</a>
    <p class="privacy-note">이 사진은 ${Number(autoDeleteHours)}시간 후 자동 삭제됩니다.</p>
  </div>
</body>
</html>`;
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>사진을 찾을 수 없습니다</title>
  <link rel="stylesheet" href="/shared/app.css" />
</head>
<body>
  <div style="max-width:480px;margin:80px auto;text-align:center;padding:16px;">
    <h1>404</h1>
    <p>사진을 찾을 수 없거나 만료되었습니다.</p>
  </div>
</body>
</html>`;
}

module.exports = { registerRoutes };
