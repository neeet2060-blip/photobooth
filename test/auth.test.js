'use strict';

const test = require('node:test');
const assert = require('node:assert');

const PASSWORD = 'correct horse battery staple';

// auth.js reads process.env.PHOTOBOOTH_PASSWORD on every call (not at require
// time), so tests can toggle the gate on and off around individual cases.
const auth = require('../server/auth');

function withPassword(value, fn) {
  const previous = process.env.PHOTOBOOTH_PASSWORD;
  if (value === null) delete process.env.PHOTOBOOTH_PASSWORD;
  else process.env.PHOTOBOOTH_PASSWORD = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PHOTOBOOTH_PASSWORD;
    else process.env.PHOTOBOOTH_PASSWORD = previous;
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
  };
  return res;
}

function run(req) {
  const res = makeRes();
  let nextCalled = false;
  auth.middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('with no password configured the gate is entirely inert (LAN-only setups unchanged)', () => {
  withPassword(null, () => {
    assert.equal(auth.isEnabled(), false);
    const { nextCalled } = run({ path: '/admin', method: 'GET', headers: {} });
    assert.equal(nextCalled, true, 'every request must pass straight through');
  });
});

test('an unauthenticated request to a protected page is refused', () => {
  withPassword(PASSWORD, () => {
    const { res, nextCalled } = run({ path: '/admin', method: 'GET', headers: {} });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('an unauthenticated API call gets JSON, not the HTML login page', () => {
  withPassword(PASSWORD, () => {
    const { res } = run({ path: '/api/admin/settings', method: 'GET', headers: {} });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
  });
});

test('a valid cookie lets the request through', () => {
  withPassword(PASSWORD, () => {
    const cookie = `${auth.COOKIE_NAME}=${auth.expectedToken()}`;
    const { nextCalled } = run({ path: '/admin', method: 'GET', headers: { cookie } });
    assert.equal(nextCalled, true);
  });
});

test('a cookie minted under a different password is rejected', () => {
  const stolen = withPassword('some other password', () => auth.expectedToken());
  withPassword(PASSWORD, () => {
    const { res, nextCalled } = run({
      path: '/admin', method: 'GET', headers: { cookie: `${auth.COOKIE_NAME}=${stolen}` },
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('posting the right password sets a cookie that then works', () => {
  withPassword(PASSWORD, () => {
    auth._resetThrottleForTests();
    const res = makeRes();
    auth.middleware(
      { path: '/login', method: 'POST', headers: {}, body: { password: PASSWORD }, ip: '1.2.3.4' },
      res,
      () => { throw new Error('login must not fall through to the app'); },
    );
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/');

    const setCookie = res.headers['Set-Cookie'];
    assert.ok(setCookie.includes('HttpOnly'), 'cookie must not be readable from JS');
    assert.ok(setCookie.includes('SameSite=Lax'));

    const value = setCookie.split(';')[0].split('=')[1];
    const { nextCalled } = run({
      path: '/admin', method: 'GET', headers: { cookie: `${auth.COOKIE_NAME}=${value}` },
    });
    assert.equal(nextCalled, true);
  });
});

test('a plain-http login does not get a Secure cookie (the booth screens use http://localhost)', () => {
  withPassword(PASSWORD, () => {
    auth._resetThrottleForTests();
    const res = makeRes();
    auth.middleware(
      { path: '/login', method: 'POST', headers: {}, body: { password: PASSWORD }, ip: '1.2.3.5', secure: false },
      res,
      () => {},
    );
    assert.ok(!res.headers['Set-Cookie'].includes('Secure'));
  });
});

test('a login forwarded as https by the tunnel does get a Secure cookie', () => {
  withPassword(PASSWORD, () => {
    auth._resetThrottleForTests();
    const res = makeRes();
    auth.middleware(
      {
        path: '/login',
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
        body: { password: PASSWORD },
        ip: '1.2.3.6',
      },
      res,
      () => {},
    );
    assert.ok(res.headers['Set-Cookie'].includes('Secure'));
  });
});

test('repeated wrong guesses from one address get throttled', () => {
  withPassword(PASSWORD, () => {
    auth._resetThrottleForTests();
    const attempt = () => {
      const res = makeRes();
      auth.middleware(
        { path: '/login', method: 'POST', headers: {}, body: { password: 'wrong' }, ip: '9.9.9.9' },
        res,
        () => {},
      );
      return res.statusCode;
    };
    for (let i = 0; i < 5; i += 1) assert.equal(attempt(), 401);
    assert.equal(attempt(), 429, 'further guesses must be refused outright');
  });
});

test('the visitor download page and its image stay reachable without logging in', () => {
  withPassword(PASSWORD, () => {
    const token = 'a'.repeat(24);
    for (const p of [`/p/${token}`, `/p/${token}/image.jpg`, '/shared/app.css']) {
      const { nextCalled } = run({ path: p, method: 'GET', headers: {} });
      assert.equal(nextCalled, true, `${p} must be public — visitors never log in`);
    }
  });
});

test('the guessable /photos path is NOT public even though /p/<token> is', () => {
  withPassword(PASSWORD, () => {
    const { nextCalled, res } = run({
      path: '/photos/s1abc123/final.jpg', method: 'GET', headers: {},
    });
    assert.equal(nextCalled, false, 'sessionIds are guessable — this must require login');
    assert.equal(res.statusCode, 401);
  });
});

test('a malformed token cannot be used to sneak past the gate', () => {
  withPassword(PASSWORD, () => {
    for (const p of ['/p/../admin', '/p/short', `/p/${'a'.repeat(24)}/../../admin`]) {
      const { nextCalled } = run({ path: p, method: 'GET', headers: {} });
      assert.equal(nextCalled, false, `${p} must not be treated as public`);
    }
  });
});

test('socket handshakes without a valid cookie are refused', () => {
  withPassword(PASSWORD, () => {
    assert.equal(auth.allowSocket({ headers: {} }), false);
    assert.equal(
      auth.allowSocket({ headers: { cookie: `${auth.COOKIE_NAME}=${auth.expectedToken()}` } }),
      true,
    );
  });
});

test('socket handshakes are unrestricted when no password is configured', () => {
  withPassword(null, () => {
    assert.equal(auth.allowSocket({ headers: {} }), true);
  });
});
