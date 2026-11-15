import { store, loadLocal } from './store.js';
import * as drive from './drive.js';
import { render, renderSync, initUI, debug } from './views.js';
import { parseFile } from './parsers.js';
import { commitImport } from './importer.js';
import { flushQueue } from './evidence.js';

store.state = loadLocal();
initUI();

let pending = false;
store.listeners.add(reason => {
  const ae = document.activeElement;
  const typing = ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName) && ae.type !== 'checkbox';
  if (reason === 'remote' && typing) pending = true; // 입력 중에는 화면을 갈아엎지 않음
  else render();
  if (reason !== 'remote') drive.scheduleSync();
});
document.addEventListener('focusout', () => { if (pending) { pending = false; setTimeout(render, 0); } });
drive.onSync(() => { renderSync(); if (drive.sync.status === 'ok') flushQueue(); });
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

render();
drive.init();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    // 앱을 켜 둔 채로 있어도 다시 볼 때마다 새 버전이 있는지 확인
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  // 새 버전이 들어오면 화면을 새로 불러옴 (지출을 적는 중이면 다 적고 나간 뒤에)
  let reloading = false, waiting = false;
  const reload = () => { if (!reloading) { reloading = true; location.reload(); } };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 처음 설치될 때는 새로고침하지 않음
    if (location.hash === '#m-add') waiting = true; else reload();
  });
  window.addEventListener('hashchange', () => { if (waiting && location.hash !== '#m-add') reload(); });
}

// 개발 확인용 (localhost에서만)
if (location.hostname === 'localhost') window.__stube = { store, parseFile, commitImport, ...debug };
