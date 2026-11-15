// 구글 드라이브 동기화
// - 권한: drive.file (이 앱이 만든 파일만 볼 수 있음. 대표님의 다른 드라이브 파일은 볼 수 없음)
// - 저장 위치: 내 드라이브 > "에스튜브 경리 앱 데이터" 폴더
// - 하루 한 번 백업 파일을 따로 남기고, 60개가 넘으면 오래된 것은 휴지통으로 보냅니다.
import { store, merge, replaceState } from './store.js';
import { todayStr } from './util.js';

export const CLIENT_ID = '711459099361-rfju41tpoln0vekrvc5sf81be7m1dtoo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'stube-ledger-data.json';
const FOLDER_NAME = '에스튜브 경리 앱 데이터';
const META_KEY = 'stube-ledger-sync';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export const sync = { status: 'off', msg: '', lastAt: 0 };
let token = null, tokenExp = 0, gisPromise = null;
let meta = readMeta();
const listeners = new Set();

function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch { return {}; } }
function writeMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* 무시 */ } }
function emit(status, msg = '') { sync.status = status; sync.msg = msg; for (const f of listeners) f(); }
export function onSync(f) { listeners.add(f); }
export function wasConnected() { return !!meta.connected; }

export function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { gisPromise = null; rej(new Error('구글 로그인 모듈을 불러오지 못했습니다')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function init() {
  emit(meta.connected ? 'needLogin' : 'off');
  loadGis().catch(() => {});
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120000);
}

// 버튼 클릭에서 바로 호출해야 팝업이 막히지 않습니다.
export function connect() {
  return new Promise((resolve, reject) => {
    const go = () => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: resp => {
          if (resp.error) { emit('error', '로그인 실패: ' + resp.error); reject(new Error(resp.error)); return; }
          token = resp.access_token;
          tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
          meta.connected = true; writeMeta();
          resolve();
          syncNow();
        },
        error_callback: err => { emit(meta.connected ? 'needLogin' : 'off'); reject(new Error(err?.type || 'popup')); },
      });
      client.requestAccessToken({ prompt: meta.connected ? '' : 'consent' });
    };
    if (window.google?.accounts?.oauth2) go();
    else loadGis().then(go, e => { emit('error', e.message); reject(e); });
  });
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; meta = {}; writeMeta(); emit('off');
}

async function api(url, opts = {}) {
  if (!token || Date.now() > tokenExp) { token = null; emit('needLogin'); throw new Error('NEED_LOGIN'); }
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; emit('needLogin'); throw new Error('NEED_LOGIN'); }
  if (!r.ok) throw new Error(explain(r.status, await r.text()));
  return r;
}

// 구글이 돌려준 오류를 대표님이 알아볼 수 있는 말로 바꿉니다.
export const API_ON_URL = 'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=stube-ledger-514802';
function explain(status, text) {
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) return 'API_OFF';
  if (/storageQuotaExceeded/i.test(text)) return '구글 드라이브 저장 공간이 꽉 찼습니다';
  if (status === 429 || status >= 500 || /rateLimitExceeded|userRateLimitExceeded/i.test(text)) return '구글 서버가 잠시 바쁩니다 (잠시 후 다시 시도)';
  return '드라이브 오류 ' + status + ': ' + text.replace(/\s+/g, ' ').slice(0, 200);
}

async function findFile(name, mime, parent) {
  let q = `name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  if (mime) q += ` and mimeType='${mime}'`;
  if (parent) q += ` and '${parent}' in parents`;
  const r = await api(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name,version)&spaces=drive&orderBy=modifiedTime desc`);
  return (await r.json()).files?.[0] || null;
}

async function ensureFolder() {
  if (meta.folderId) {
    try {
      const r = await api(`${DRIVE}/${meta.folderId}?fields=id,trashed`);
      const f = await r.json();
      if (!f.trashed) return f.id;
    } catch (e) { if (e.message === 'NEED_LOGIN') throw e; }
  }
  let f = await findFile(FOLDER_NAME, 'application/vnd.google-apps.folder');
  if (!f) {
    const r = await api(`${DRIVE}?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    f = await r.json();
  }
  meta.folderId = f.id; writeMeta();
  return f.id;
}

async function createFile(name, folderId, content) {
  const b = 'stube' + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' })}\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
  const r = await api(`${UPLOAD}?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  return r.json();
}

async function updateFile(id, content) {
  const r = await api(`${UPLOAD}/${id}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: content });
  return r.json();
}

let running = null, again = false, timer = null;
export function scheduleSync() {
  if (!token) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), 2500);
}

export function syncNow() {
  if (!token) { if (meta.connected) emit('needLogin'); return Promise.resolve(); }
  if (running) { again = true; return running; }
  running = doSync().finally(() => { running = null; if (again) { again = false; syncNow(); } });
  return running;
}

async function doSync() {
  if (!navigator.onLine) { emit('offline'); return; }
  emit('syncing');
  try {
    const folderId = await ensureFolder();
    let file = null;
    if (meta.fileId) {
      try { const r = await api(`${DRIVE}/${meta.fileId}?fields=id,version,trashed`); file = await r.json(); if (file.trashed) file = null; }
      catch (e) { if (e.message === 'NEED_LOGIN') throw e; file = null; }
    }
    if (!file) file = await findFile(FILE_NAME, null, folderId);
    if (!file) {
      const created = await createFile(FILE_NAME, folderId, JSON.stringify(store.state));
      meta.fileId = created.id; meta.version = String(created.version);
      store.dirty = false;
    } else {
      meta.fileId = file.id;
      let needUpload = store.dirty;
      if (String(file.version) !== String(meta.version)) {
        const r = await api(`${DRIVE}/${file.id}?alt=media`);
        const remote = await r.json();
        const { state, aWins } = merge(store.state, remote);
        replaceState(state, 'remote');
        needUpload = needUpload || aWins > 0;
        meta.version = String(file.version);
      }
      if (needUpload) {
        store.dirty = false;
        const up = await updateFile(file.id, JSON.stringify(store.state));
        meta.version = String(up.version);
      }
    }
    writeMeta();
    await dailyBackup(folderId);
    sync.lastAt = Date.now();
    emit('ok');
  } catch (e) {
    if (e.message === 'NEED_LOGIN') { store.dirty = true; return; }
    store.dirty = true;
    emit('error', e.message);
  }
}

async function dailyBackup(folderId) {
  const today = todayStr();
  if (meta.backupDay === today) return;
  await createFile(`backup-${today}.json`, folderId, JSON.stringify(store.state));
  meta.backupDay = today; writeMeta();
  const q = `name contains 'backup-' and '${folderId}' in parents and trashed=false`;
  const r = await api(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name desc&pageSize=200`);
  const files = (await r.json()).files || [];
  for (const f of files.slice(60)) {
    await api(`${DRIVE}/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
}
