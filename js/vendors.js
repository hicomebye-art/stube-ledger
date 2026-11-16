// 거래처 계좌 + 지급 기록
// "지급 기록"은 송금 기능이 아닙니다. 실제로 은행 앱 등에서 보낸 뒤, 그 사실을 장부에 적는 기능입니다.
// 한 번의 지급을 계산서별 금액으로 나눠 저장하고(paylogs), 통장 출금 예정 기록(manual)을 하나 만듭니다.
// 나중에 통장 자료가 들어오면 그 출금과 합쳐지고, 같은 돈이 두 번 잡히지 않습니다.
import { store, put, patch, remove, live } from './store.js';
import { hash, nowTs, won } from './util.js';
import { cleanAcctNo, maskAcct, deviceName, audit } from './payroll.js';
import * as drive from './drive.js';

export { maskAcct };
export const vendorId = (biz, name = '') => 'vd_' + (String(biz || '').replace(/\D/g, '') || hash(String(name)));
export const vendorOf = (biz, name) => store.state.vendors?.[vendorId(biz, name)];
export const vendorLive = (biz, name) => { const v = vendorOf(biz, name); return v && !v.deleted ? v : null; };

// 전체 계좌번호 보기·복사: 이 장부의 주인(구글 드라이브에 연결해 장부를 연 사람)만
export const canSeeAcct = () => drive.hasToken();

export function setVendorAccount(biz, name, { bank, holder, acctNo }) {
  const id = vendorId(biz, name);
  const no = cleanAcctNo(acctNo);
  const digits = no.replace(/\D/g, '');
  if (no && digits.length < 8) return { err: '계좌 번호가 너무 짧습니다 (숫자 8자리 이상)' };
  const old = vendorOf(biz, name);
  const last4 = digits.slice(-4);
  const hist = [...(old?.history || [])];
  if (old && (old.acctNo || '') !== no) hist.push({ at: nowTs(), by: deviceName(), from: old.last4 ? '****' + old.last4 : '', to: last4 ? '****' + last4 : '' });
  const rec = { id, biz: biz || '', name, bank: String(bank || '').trim(), holder: String(holder || '').trim(), acctNo: no, last4, history: hist.slice(-20), at: nowTs() };
  if (old && !old.deleted) patch('vendors', id, rec); else put('vendors', rec);
  return { ok: true, changed: !!old && (old.acctNo || '') !== no };
}

// 같은 날·같은 통장·같은 계산서별 금액이면 같은 지급 → 같은 번호 (두 번 저장 안 됨)
export const payKey = (date, acct, alloc) => 'pl_' + hash([date, acct, ...[...alloc].sort((a, b) => (a.inv < b.inv ? -1 : 1)).map(a => `${a.inv}=${a.amt}`)].join('|'));

// M: model(). alloc: [{inv, amt}] — 계산서마다 이번에 보낸 금액
export function recordPayment(M, { date, acct, alloc, memo = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { err: '지급일을 넣어주세요' };
  if (!acct || !M.acctById[acct]) return { err: '어느 통장에서 보냈는지 골라주세요' };
  const rows = alloc.filter(a => a.amt !== 0);
  if (!rows.length) return { err: '지급할 계산서를 고르고 금액을 넣어주세요' };
  let biz = null, name = '';
  for (const a of rows) {
    const i = M.inv.byId[a.inv], s = M.inv.st[a.inv];
    if (!i || i.deleted || i.kind !== 'purchase') return { err: '매입 계산서만 지급 기록할 수 있습니다' };
    if (biz !== null && i.biz !== biz) return { err: '한 번의 지급 기록에는 한 거래처의 계산서만 넣을 수 있습니다' };
    biz = i.biz; name = i.name;
    if (!Number.isSafeInteger(a.amt) || a.amt <= 0) return { err: `${i.wdate} 계산서 지급액을 1원 이상 정수로 넣어주세요` };
    if (a.amt > s.remain) return { err: `${i.wdate.slice(5).replace('-', '/')} 계산서는 남은 금액이 ${won(s.remain)}원입니다. 그보다 많이 기록할 수 없습니다 (두 번 잡힘 방지)` };
  }
  const id = payKey(date, acct, rows);
  if (store.state.paylogs?.[id] && !store.state.paylogs[id].deleted) return { err: '같은 지급이 이미 기록돼 있습니다 (중복 저장 안 함)', dup: true };
  const total = rows.reduce((s, a) => s + a.amt, 0);
  const manualId = 'm_' + id;
  const memoTxt = `${name} 지급 (계산서 ${rows.length}건)${memo ? ' · ' + memo : ''}`;
  put('manual', { id: manualId, acct, date, amount: total, memo: memoTxt.slice(0, 80), personal: false, linkTxn: '', payId: id });
  put('paylogs', { id, date, acct, total, biz, name, alloc: rows.map(a => ({ inv: a.inv, amt: a.amt })), memo: String(memo).trim(), manualId, at: nowTs(), by: deviceName() });
  audit(date.slice(0, 7), 'payRecord', null, { id, name, total, n: rows.length });
  return { ok: true, id, total };
}

export function cancelPayment(id, reason = '') {
  const p = store.state.paylogs?.[id];
  if (!p || p.deleted) return false;
  remove('paylogs', id);
  if (p.manualId && store.state.manual?.[p.manualId]) remove('manual', p.manualId);
  audit(p.date.slice(0, 7), 'payCancel', { id, name: p.name, total: p.total }, null, reason);
  return true;
}

export const paylogsOf = biz => live('paylogs').filter(p => p.biz === biz).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.at < b.at ? 1 : -1)));
