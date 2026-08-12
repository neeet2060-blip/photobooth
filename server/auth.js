'use strict';

/**
 * Password gate for the whole booth, added when the app stopped being
 * LAN-only (2026-08-12, Tailscale Funnel — see WINDOWS-SETUP.md). On a LAN
 * the network itself was the boundary; on a public URL anyone who learns the
 * hostname could otherwise open /admin, change prices, read takings, or
 * dispatch socket actions (confirmPrintPayment = free prints, forceReset =
 * kill a paying visitor's session mid-flow).
 *
 * Deliberately dependency-free (node:crypto only): the event PC installs
 * packages over whatever hotspot the venue has, so this must not add an npm
 * install step on event day.
 *
 * Stateless by design — the cookie is an HMAC derived from the password
 * itself, not a row in a session table. A pm2 restart mid-event therefore
 * does NOT log the booth's own screens out (they would have to be re-logged-in
 * by hand, at the counter, with visitors waiting).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'pb_auth';
// Bumping this string invalidates every issued cookie (e.g. after a password
// leak) without needing any server-side state to revoke.
const TOKEN_PURPOSE = 'photobooth-auth-v1';

// Visitors reach their own photo through a crypto.randomBytes(12) token in
// the URL, which they get from the QR code — they never log in. Everything
// NOT matched here requires a session cookie. app.css is the one asset the
// download page pulls in; without it visitors get an unstyled page.
const PUBLIC_PATH_REGEX = /^(\/p\/[a-f0-9]{24}(\/image\.jpg)?|\/shared\/app\.css)$/;

function getPassword() {
  return process.env.PHOTOBOOTH_PASSWORD || '';
}

function isEnabled() {
  return getPassword().length > 0;
}

function expectedToken() {
  return crypto.createHmac('sha256', getPassword()).update(TOKEN_PURPOSE).digest('hex');
}

/**
 * Constant-time compare that tolerates length mismatches (timingSafeEqual
 * throws when the two buffers differ in length, and that throw would itself
 * leak length information through timing/error behavior).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** @returns {boolean} true if this request carries a valid session cookie. */
function hasValidCookie(req) {
  if (!isEnabled()) return true;
  const cookies = parseCookies(req && req.headers && req.headers.cookie);
  const presented = cookies[COOKIE_NAME];
  if (!presented) return false;
  return safeEqual(presented, expectedToken());
}

function isPublicPath(pathname) {
  return PUBLIC_PATH_REGEX.test(pathname);
}

// ---- Brute-force damping -------------------------------------------------
// A public URL means unlimited guesses from anywhere. This is not a full rate
// limiter (a single-process booth doesn't need one) — it just makes an online
// dictionary attack take impractically long, while never locking out staff
// for more than a few seconds after their own typo.
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map(); // ip -> { count, firstAt }

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function isThrottled(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function clearFailures(ip) {
  failures.delete(ip);
}

function renderLoginPage({ error } = {}) {
  const message = error
    ? '<p class="err">비밀번호가 틀렸습니다.</p>'
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>포토부스 로그인</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #111; color: #eee;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  form { display: flex; flex-direction: column; gap: 12px; width: min(320px, 80vw); }
  h1 { font-size: 20px; margin: 0 0 8px; text-align: center; }
  input { padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #444;
          background: #222; color: #eee; }
  button { padding: 12px; font-size: 16px; border-radius: 8px; border: 0;
           background: #e05c8a; color: #fff; font-weight: 600; }
  .err { color: #ff8080; text-align: center; margin: 0; font-size: 14px; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>인생네컷 포토부스</h1>
    ${message}
    <input type="password" name="password" placeholder="비밀번호" autofocus required>
    <button type="submit">들어가기</button>
  </form>
</body>
</html>`;
}

/**
 * Express middleware enforcing the gate. Registered before every other route
 * in server/index.js so that nothing — including express.static — can be
 * reached without a cookie.
 */
function middleware(req, res, next) {
  if (!isEnabled()) return next();

  const pathname = req.path || '';
  if (isPublicPath(pathname)) return next();

  if (pathname === '/login') {
    if (req.method === 'GET') {
      return res.status(200).send(renderLoginPage());
    }
    if (req.method === 'POST') {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      if (isThrottled(ip)) {
        return res.status(429).send(renderLoginPage({ error: true }));
      }
      const supplied = (req.body && req.body.password) || '';
      if (!safeEqual(supplied, getPassword())) {
        recordFailure(ip);
        return res.status(401).send(renderLoginPage({ error: true }));
      }
      clearFailures(ip);
      // Secure is set only when the request actually arrived over TLS —
      // the booth's own screens use plain http://localhost, where a Secure
      // cookie would be silently dropped and log them straight back out.
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${expectedToken()}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=31536000',
        secure ? 'Secure' : '',
      ].filter(Boolean).join('; '));
      return res.redirect(303, '/');
    }
  }

  if (hasValidCookie(req)) return next();

  // XHR/fetch callers get a machine-readable 401 instead of an HTML page they
  // would try (and fail) to parse as JSON.
  const wantsJson = pathname.startsWith('/api/')
    || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return res.status(401).send(renderLoginPage());
}

/**
 * Socket.IO handshake guard. Without this the HTTP gate alone would be
 * cosmetic: socket connections carry their own handshake and would otherwise
 * accept `action` events (confirmPrintPayment, forceReset, ...) from anyone.
 */
function allowSocket(handshake) {
  if (!isEnabled()) return true;
  return hasValidCookie({ headers: (handshake && handshake.headers) || {} });
}

module.exports = {
  middleware,
  allowSocket,
  isEnabled,
  hasValidCookie,
  isPublicPath,
  COOKIE_NAME,
  expectedToken,
  _resetThrottleForTests: () => failures.clear(),
};
