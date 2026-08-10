module.exports = {
  apps: [
    {
      name: 'photobooth',
      script: 'server/index.js',
      cwd: __dirname,
      env: {
        TOK2026_EVENT_ID: 'de-dietzenbach-2026',
      },
      // 행사 당일 크래시가 나도 자동 재시작 — 무인 부스 특성상 사람이 계속 지켜볼 수 없다.
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
    },
  ],
};
