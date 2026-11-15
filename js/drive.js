// 구글 드라이브 동기화
// - 권한: drive.file (이 앱이 만든 파일만 볼 수 있음. 대표님의 다른 드라이브 파일은 볼 수 없음)
// - 저장 위치: 내 드라이브 > "에스튜브 경리 앱 데이터" 폴더
// - 하루 한 번 백업 파일을 따로 남기고, 60개가 넘으면 오래된 것은 휴지통으로 보냅니다.
import { store, merge, replaceState } from './store.js';
import { todayStr } from './util.js';

export const CLIENT_ID = '711459099361-rfju41tpoln0vekrvc5sf81be7m1dtoo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
import { SANDBOX, NS } from './env.js';

const FILE_NAME = 'stube-ledger-data.json';
// 테스트 장부는 다른 폴더를 써서 실제 장부 파일을 절대 건드리지 않습니다.
const FOLDER_NAME = '에스튜브 경리 앱 데이터' + (SANDBOX ? ` (테스트 ${SANDBOX})` : '');
const META_KEY = 'stube-ledger-sync' + NS;
export const APP_VERSION = '3';
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

// 구글 로그인 표(1시간짜리)를 이 기기에 잠시 보관해서, 앱을 다시 열거나 새로고침해도 바로 이어서 저장되게 합니다.
// (이 앱이 만든 파일만 다룰 수 있는 권한이고, 1시간이 지나면 저절로 쓸 수 없게 됩니다)
function keepToken() { meta.tok = token; meta.tokExp = tokenExp; writeMeta(); }
function dropToken() { token = null; delete meta.tok; delete meta.tokExp; writeMeta(); }

export function init() {
  if (meta.connected && meta.tok && Date.now() < Number(meta.tokExp || 0)) { token = meta.tok; tokenExp = Number(meta.tokExp); }
  emit(token ? 'syncing' : meta.connected ? 'needLogin' : 'off');
  if (token) setTimeout(() => syncNow(), 0);
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
          meta.connected = true; keepToken();
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
  if (!token || Date.now() > tokenExp) { dropToken(); emit('needLogin'); throw new Error('NEED_LOGIN'); }
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (r.status === 401) { dropToken(); emit('needLogin'); throw new Error('NEED_LOGIN'); }
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
  running = doSync().finally(() => {
    running = null;
    if (again) { again = false; return syncNow(); }
  });
  return running;
}

// ───── 증빙 사진 (장부 폴더 안 "증빙 사진" 폴더, 대표님 드라이브에 비공개) ─────
export const hasToken = () => !!token && Date.now() < tokenExp;
const EVID_FOLDER = '증빙 사진';
async function ensureEvidFolder() {
  const parent = await ensureFolder();
  if (meta.evidFolderId) {
    try { const f = await (await api(`${DRIVE}/${meta.evidFolderId}?fields=id,trashed`)).json(); if (!f.trashed) return f.id; }
    catch (e) { if (e.message === 'NEED_LOGIN') throw e; }
  }
  let f = await findFile(EVID_FOLDER, 'application/vnd.google-apps.folder', parent);
  if (!f) f = await (await api(`${DRIVE}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: EVID_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) })).json();
  meta.evidFolderId = f.id; writeMeta();
  return f.id;
}
export async function uploadBlob(blob, name) {
  const folderId = await ensureEvidFolder();
  const { id } = await (await api(`${DRIVE}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [folderId], mimeType: blob.type || 'application/octet-stream' }) })).json();
  await api(`${UPLOAD}/${id}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  return id;
}
export async function downloadBlob(id) { return (await api(`${DRIVE}/${id}?alt=media`)).blob(); }

// 사진 글자 읽기: 구글 드라이브의 글자 인식(사진 → 구글 문서 변환)을 써서 글자만 받아오고, 임시 문서는 바로 지웁니다.
// 추가 가입·비용 없음. 대표님 드라이브 안에서만 처리됩니다.
export async function ocrImage(blob) {
  const folderId = await ensureEvidFolder();
  const b = 'ocr' + Math.random().toString(36).slice(2);
  const meta1 = JSON.stringify({ name: 'ocr-temp-' + Date.now(), mimeType: 'application/vnd.google-apps.document', parents: [folderId] });
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta1}\r\n--${b}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`, blob, `\r\n--${b}--`]);
  const { id } = await (await api(`${UPLOAD}?uploadType=multipart&ocrLanguage=ko&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
  try { return await (await api(`${DRIVE}/${id}/export?mimeType=text/plain`)).text(); }
  finally { api(`${DRIVE}/${id}`, { method: 'DELETE' }).catch(() => {}); }
}

// 진행 중인 저장(다시 확인 포함)이 모두 끝날 때까지 기다림
export async function whenIdle() { while (running) await running; }

// 자동 테스트 전용 (localhost의 테스트 장부에서만 동작): 가짜 로그인 토큰
export function __testLogin() {
  if (!SANDBOX || location.hostname !== 'localhost') return false;
  token = 'test'; tokenExp = Date.now() + 3600e3; meta.connected = true; writeMeta();
  return true;
}

// 기기마다 자기 파일(stube-ledger-dev-기기번호.json)에만 씁니다.
// 읽을 때는 폴더의 모든 장부 파일(예전 공용 파일 포함)을 받아서 합칩니다.
// → 두 기기가 동시에 저장해도 서로의 파일을 덮어쓸 수 없으므로 한쪽 기록이 사라지지 않습니다.
let DEV = '';
function devId() {
  if (DEV) return DEV;
  const k = 'stube-ledger-dev' + NS;
  try { DEV = localStorage.getItem(k) || ''; } catch { DEV = ''; }
  if (!/^[0-9a-z]{6,12}$/.test(DEV)) { DEV = Math.random().toString(36).slice(2, 10).padEnd(8, '0'); try { localStorage.setItem(k, DEV); } catch { /* 저장 불가 */ } }
  return DEV;
}
const myName = () => `stube-ledger-dev-${devId()}.json`;
const isLedgerFile = n => n === FILE_NAME || /^stube-ledger-dev-[0-9a-z]+\.json$/.test(n);

async function doSync() {
  if (!navigator.onLine) { emit('offline'); return; }
  emit('syncing');
  try {
    const folderId = await ensureFolder();
    const q = `name contains 'stube-ledger-' and '${folderId}' in parents and trashed=false`;
    const list = ((await (await api(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name,version)&pageSize=200`)).json()).files || []).filter(f => isLedgerFile(f.name));
    const mine = list.find(f => f.name === myName());
    meta.seen = meta.seen || {};
    // 새 버전으로 바뀐 뒤 처음: 예전 공용 장부 파일을 그대로 따로 보관 (되돌리기용)
    if (meta.appVer !== APP_VERSION) {
      const main = list.find(f => f.name === FILE_NAME);
      const bname = `backup-before-v${APP_VERSION}-${todayStr()}.json`;
      if (main && !(await findFile(bname, null, folderId))) await createFile(bname, folderId, await (await api(`${DRIVE}/${main.id}?alt=media`)).text());
      meta.appVer = APP_VERSION; writeMeta();
    }
    // 바뀐 파일만 받기
    const remotes = [];
    for (const f of list) {
      if (String(meta.seen[f.id]) === String(f.version)) continue;
      remotes.push({ f, data: await (await api(`${DRIVE}/${f.id}?alt=media`)).json() });
    }
    // 받는 동안 이 기기에서 고친 것도 살리도록, 합치기는 지금 상태에 바로 합니다
    if (remotes.length) {
      let st = store.state;
      for (const r of remotes) { st = merge(st, r.data).state; meta.seen[r.f.id] = String(r.f.version); }
      replaceState(st, 'remote');
    }
    // 내 파일 올리기 (이 기기만 쓰는 파일)
    if (store.dirty || !mine) {
      store.dirty = false;
      const body = JSON.stringify(store.state);
      const up = mine ? await updateFile(mine.id, body) : await createFile(myName(), folderId, body);
      meta.seen[up.id || mine.id] = String(up.version);
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
  // 다른 기기가 오늘 백업을 이미 만들었으면 또 만들지 않음
  if (!(await findFile(`backup-${today}.json`, null, folderId))) await createFile(`backup-${today}.json`, folderId, JSON.stringify(store.state));
  meta.backupDay = today; writeMeta();
  const q = `name contains 'backup-' and '${folderId}' in parents and trashed=false`;
  const r = await api(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name desc&pageSize=200`);
  const files = (await r.json()).files || [];
  for (const f of files.slice(60)) {
    await api(`${DRIVE}/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
}
