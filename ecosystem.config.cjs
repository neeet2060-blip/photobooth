const fs = require('fs');
const path = require('path');

// The booth password lives in secrets/ (gitignored) rather than inline here,
// because this file IS tracked in git — inlining it would publish the
// password to anyone with repo access. Missing file => empty => the password
// gate turns itself off, which is correct for LAN-only use and which
// server/index.js announces loudly at boot so it can't pass unnoticed when
// the booth is on a public tunnel URL.
function readPassword() {
  try {
    return fs.readFileSync(path.join(__dirname, 'secrets', 'password.txt'), 'utf8').trim();
  } catch (err) {
    return '';
  }
}

module.exports = {
  apps: [
    {
      name: 'photobooth',
      script: 'server/index.js',
      cwd: __dirname,
      env: {
        TOK2026_EVENT_ID: 'de-dietzenbach-2026',
        PHOTOBOOTH_PASSWORD: readPassword(),
        // Tailscale Funnel hostname — fixed for the life of this machine, so
        // tablets/QR links never need re-pointing when the venue's network
        // changes. Used for the QR fallback URL (see server/routes.js).
        PHOTOBOOTH_PUBLIC_URL: 'https://photobooth.tail76f321.ts.net',
      },
      // 행사 당일 크래시가 나도 자동 재시작 — 무인 부스 특성상 사람이 계속 지켜볼 수 없다.
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      // 코드 파일(server/, public/)이 바뀌면 자동 재시작(2026-08-10) — git pull/커밋 후 사람이
      // 수동으로 pm2 restart를 안 해도 되게 함. data/(사진·세션 등 런타임 파일)는 절대 감시
      // 목록에 넣지 않는다 — 넣으면 손님이 촬영 중 생기는 파일 변경만으로도 재시작이 걸려
      // 결제·촬영 세션이 끊길 수 있다.
      watch: ['server', 'public'],
      ignore_watch: ['node_modules', '*.log'],
      watch_delay: 1000,
    },
  ],
};
