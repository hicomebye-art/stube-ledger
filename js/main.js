import { store, loadLocal } from './store.js';
import * as drive from './drive.js';
import { render, renderSync, initUI, debug } from './views.js';
import { parseFile } from './parsers.js';
import { commitImport } from './importer.js';

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
drive.onSync(renderSync);
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

render();
drive.init();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 개발 확인용 (localhost에서만)
if (location.hostname === 'localhost') window.__stube = { store, parseFile, commitImport, ...debug };
