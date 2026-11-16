// 오프라인에서도 앱 화면이 열리도록 앱 파일만 보관합니다. (장부 자료와 구글 통신은 보관하지 않음)
const CACHE = 'stube-ledger-v3-12';
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/env.js', 'js/util.js', 'js/jobs.js', 'js/jobs-ui.js', 'js/evidence.js', 'js/ocr.js', 'js/tax.js', 'js/tax-ui.js', 'js/payroll.js', 'js/payroll-ui.js', 'js/store.js', 'js/engine.js', 'js/parsers.js', 'js/importer.js', 'js/drive.js', 'js/views.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL);
    try { await c.add(CDN); } catch { /* 나중에 받음 */ }
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  const mine = u.origin === location.origin && u.pathname.startsWith(SCOPE);
  if (!mine && u.href !== CDN) return;
  // 앱 파일은 매번 서버에 새 버전이 있는지 확인 (브라우저에 남은 예전 파일을 쓰지 않음)
  e.respondWith(
    fetch(e.request, mine ? { cache: 'no-cache' } : undefined).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
