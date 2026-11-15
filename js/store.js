// 데이터 저장소: 이 기기(localStorage)에 먼저 저장하고, 구글 드라이브와 동기화합니다.
// 모든 기록은 u(수정 시각)를 가지고, 두 기기의 자료를 합칠 때 더 최근 것을 씁니다.

import { NS } from './env.js';

// 테스트 장부(?test=)는 다른 칸에 저장해서 실제 장부와 섞이지 않습니다.
const KEY = 'stube-ledger-v1' + NS;
const DIRTY_KEY = 'stube-ledger-dirty' + NS;

// parties 거래처, sites 현장, jobs 작업건, costs 원가(비용), evid 증빙 사진 정보
export const COLS = ['accounts', 'txns', 'manual', 'invoices', 'plans', 'recurring', 'imports', 'decisions', 'aliases', 'parties', 'sites', 'jobs', 'costs', 'evid', 'taxdocs', 'employees', 'payruns', 'closes', 'audit', 'payfiles'];

// 계좌번호·이름 같은 개인정보는 코드에 넣지 않습니다. (설정 화면에서 입력 → 드라이브에만 저장)
const DEFAULT_ACCOUNTS = [
  { id: 'suhyup', name: '수협', holder: '', order: 1 },
  { id: 'nh', name: '농협', holder: '', order: 2 },
  { id: 'kakao', name: '카카오뱅크', holder: '', order: 3 },
  { id: 'post', name: '우체국', holder: '', order: 4 },
];

export function emptyState() {
  const s = {
    schema: 1,
    settings: { u: 0, minBalance: 0, includePersonal: true, vatPrepaid: {}, cycleDays: 15 },
  };
  for (const c of COLS) s[c] = {};
  for (const a of DEFAULT_ACCOUNTS) s.accounts[a.id] = { ...a, u: 0 };
  return s;
}

function normalize(s) {
  const e = emptyState();
  for (const c of COLS) s[c] = s[c] || e[c];
  s.settings = { ...e.settings, ...(s.settings || {}) };
  for (const a of Object.values(e.accounts)) if (!s.accounts[a.id]) s.accounts[a.id] = a;
  s.schema = Math.max(Number(s.schema) || 1, 1);
  return s;
}

export const store = {
  state: null,
  rev: 0,
  listeners: new Set(),
  get dirty() { try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch { return true; } },
  set dirty(v) { try { localStorage.setItem(DIRTY_KEY, v ? '1' : '0'); } catch { /* 저장 불가 환경 */ } },
};

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.warn('local load failed', e); }
  return emptyState();
}

export function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(store.state)); }
  catch (e) { console.warn('local save failed', e); }
}

function notify(reason) { for (const f of store.listeners) f(reason); }

// 사용자가 바꾼 내용 저장 → 동기화 대상
export function commit(reason = '') {
  store.rev++;
  store.dirty = true;
  saveLocal();
  notify(reason);
}

// 드라이브에서 받은 자료로 교체 (동기화 대상 표시는 하지 않음)
export function replaceState(s, reason = 'remote') {
  store.state = normalize(s);
  store.rev++;
  saveLocal();
  notify(reason);
}

export function put(col, rec) {
  rec.u = Date.now();
  store.state[col][rec.id] = rec;
  return rec;
}

export function patch(col, id, fields) {
  const r = store.state[col][id];
  if (!r || r.deleted) return null;
  Object.assign(r, fields, { u: Date.now() });
  return r;
}

export function remove(col, id) {
  if (store.state[col][id]) store.state[col][id] = { id, deleted: true, u: Date.now() };
}

export function setSettings(fields) {
  Object.assign(store.state.settings, fields, { u: Date.now() });
}

export function live(col) {
  return Object.values(store.state[col]).filter(r => r && !r.deleted);
}

// 두 자료 합치기: 기록마다 더 최근(u가 큰) 것을 고릅니다.
// aWins: a(이 기기)에서만 있거나 더 최신인 기록 수 → 드라이브에 다시 올려야 하는지 판단
// 이 버전이 모르는 묶음(나중 버전에서 추가된 자료)도 버리지 않고 그대로 합칩니다.
const isCol = (o, k) => k !== 'settings' && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]);
export function merge(a, b) {
  const out = emptyState();
  let aWins = 0;
  const cols = new Set([...COLS, ...Object.keys(a).filter(k => isCol(a, k)), ...Object.keys(b).filter(k => isCol(b, k))]);
  for (const c of cols) {
    out[c] ||= {};
    const A = a[c] || {}, B = b[c] || {};
    const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
    for (const k of keys) {
      const x = A[k], y = B[k];
      if (!y) { out[c][k] = x; aWins++; }
      else if (!x) out[c][k] = y;
      else if ((x.u || 0) > (y.u || 0)) { out[c][k] = x; aWins++; }
      else out[c][k] = y;
    }
  }
  const sa = a.settings || {}, sb = b.settings || {};
  if ((sa.u || 0) > (sb.u || 0)) { out.settings = { ...out.settings, ...sa }; aWins++; }
  else out.settings = { ...out.settings, ...sb };
  return { state: out, aWins };
}
