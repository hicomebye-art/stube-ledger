// 급여·주급·월 마감 계산 (화면 없음)
// 원칙
// - 금액은 원 단위 정수. 확정(사용자가 [급여 확정])한 것만 지급 예정에 들어감. 자료가 없으면 "급여자료 대기" — 지난달 금액을 복사하지 않음.
// - 출근 기록·일당·기간·공제를 확인할 수 없으면 "확인 필요"로 두고 0원으로 확정하지 않음.
// - 확정·지급된 기록은 덮어쓰지 않음. 새 자료가 다르면 "변경 전 → 후, 차액"을 따로 보여주고 사용자가 반영.
// - 계좌는 끝 4자리만 장부에 저장. 이름만으로 계좌를 자동 연결하지 않음.
// - 송금하지 않음. "지급 확인(사용자)"과 "은행 거래 대조 완료"를 구분.
import { store, live, put, patch } from './store.js';
import { todayStr, addDays, dayDiff, ymOf, addMonths, normName, uid, nowTs } from './util.js';
import { covered } from './engine.js';

export const EMP_KIND = { ledger: '임금대장 (월급)', monthlyDaily: '출근 기록 × 일당 (월 정산)', weekly: '출근 기록 × 일당 (주급)' };
export const DAY_KIND = { weekday: '평일 근무', weekend: '토·일 근무', holiday: '휴일 근무', half: '반일 근무', custom: '별도 금액' };
const WD = ['일', '월', '화', '수', '목', '금', '토'];
export const dow = d => new Date(d + 'T00:00:00').getDay();
export const wdName = d => WD[dow(d)];

// 공휴일 (참고용 기본값. 화면에서 날마다 바꿀 수 있음)
const HOLIDAYS = new Set([
  '2025-12-25',
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-01', '2026-03-02', '2026-05-05', '2026-05-24', '2026-05-25',
  '2026-06-03', '2026-06-06', '2026-08-15', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-03', '2026-10-05',
  '2026-10-09', '2026-12-25', '2027-01-01',
]);
export const isHoliday = d => HOLIDAYS.has(d);
export const defaultDayKind = d => (isHoliday(d) ? 'holiday' : dow(d) === 0 || dow(d) === 6 ? 'weekend' : 'weekday');

// ───── 직원 ─────
export const employees = () => live('employees').filter(e => e.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'ko'));
export const empById = id => { const e = store.state.employees?.[id]; return e && !e.deleted ? e : null; };
export function acctReady(e) { return e && e.acct?.status === 'ready' && /^\d{4}$/.test(e.last4 || '') && e.bank && e.holder; }

// 계좌 바꾸기: 끝 4자리·은행·예금주가 바뀌면 "확인 전"으로 돌아감 (사용자가 확인해야 이체 준비 완료)
export function setAccount(empId, { bank, holder, last4 }) {
  const e = empById(empId);
  const changed = e.bank !== bank || e.holder !== holder || e.last4 !== last4;
  if (!changed) return e;
  const hist = [...(e.acct?.history || []), { at: nowTs(), bank: e.bank || '', holder: e.holder || '', last4: e.last4 || '', status: e.acct?.status || '' }];
  return patch('employees', empId, { bank, holder, last4, acct: { status: 'unverified', history: hist.slice(-20) } });
}
export function confirmAccount(empId) {
  const e = empById(empId);
  if (!/^\d{4}$/.test(e.last4 || '') || !e.bank || !e.holder) return false;
  patch('employees', empId, { acct: { ...(e.acct || {}), status: 'ready', confirmedAt: nowTs() } });
  return true;
}

// ───── 급여 건 (payruns) ─────
export const runIdMonthly = (empId, payYm) => `pr_${empId}_${payYm}`;
export const runIdWeekly = (empId, monday) => `pr_${empId}_w${monday}`;
export const runOf = id => { const r = store.state.payruns?.[id]; return r && !r.deleted ? r : null; };

// 출근 기록 월 정산 기간: 전월 16일 ~ 당월 15일
export function monthlyPeriod(payYm) { return { from: `${addMonths(payYm, -1)}-16`, to: `${payYm}-15` }; }
// 주: 월요일 ~ 일요일
export function mondayOf(d) { const k = (dow(d) + 6) % 7; return addDays(d, -k); }
export function weekDays(monday) { return { from: monday, to: addDays(monday, 6), sat: addDays(monday, 5), sun: addDays(monday, 6) }; }
// 그 달과 하루라도 겹치는 주(월요일 날짜 목록)
export function weeksTouching(ym) {
  const out = [];
  for (let m = mondayOf(`${ym}-01`); ymOf(m) <= ym && out.length < 7; m = addDays(m, 7)) out.push(m);
  return out;
}

// 일당 계산 (사용자가 바꾼 금액·반일·별도 금액 반영)
export function dayAmount(e, day) {
  const r = e.rates || {};
  const base = day.kind === 'weekday' ? r.weekday : (day.kind === 'weekend' || day.kind === 'holiday') ? r.weekend : day.kind === 'half' ? (day.halfOf === 'weekend' ? r.weekend : r.weekday) : null;
  if (day.kind === 'custom') return Number.isSafeInteger(day.amount) && day.amount > 0 ? day.amount : null;
  if (!Number.isSafeInteger(base) || base <= 0) return null;
  return day.kind === 'half' ? Math.floor(base / 2) : base;
}

// 3.3% (소득세 3% · 지방소득세 그 10%, 각각 10원 미만 버림)
export function deduct33(gross) {
  const tax = Math.floor((gross * 3) / 1000) * 10;   // gross × 3%, 10원 미만 버림 (정수 계산)
  const local = Math.floor(tax / 100) * 10;          // 소득세 × 10%, 10원 미만 버림
  return { tax, local, total: tax + local };
}
export function deductionOf(e, gross) {
  const d = e.deduct || {};
  if (d.mode === '3.3') return deduct33(gross).total;
  if (d.mode === 'fixed') return Number.isSafeInteger(d.amount) ? d.amount : null;
  if (d.mode === 'none') return 0;
  return null;
}

// 출근 기록으로 계산 (확인 필요한 이유도 같이)
export function calcDaily(e, run) {
  const issues = [];
  const days = (run.days || []).filter(x => x.on !== false);
  if (!run.period?.from || !run.period?.to) issues.push('집계 기간을 확인할 수 없음');
  if (!run.daysChecked) issues.push('출근일을 아직 확인하지 않음 ([출근일 확인 완료]를 눌러야 함)');
  if (!days.length) issues.push('출근 기록이 없음');
  let gross = 0;
  const lines = days.map(d => { const a = dayAmount(e, d); if (a == null) issues.push(`${d.date.slice(5)} 일당을 알 수 없음`); else gross += a; return { ...d, amount: a }; });
  if (!e.rates || !(e.rates.weekday > 0)) issues.push('평일 일당이 설정되지 않음');
  if (days.some(d => d.kind === 'weekend' || d.kind === 'holiday') && !(e.rates?.weekend > 0)) issues.push('토·일·휴일 일당이 설정되지 않음');
  if (!e.deduct?.confirmed) issues.push('공제 방식을 확인하지 않음 (직원 관리에서 확인)');
  const deduction = issues.length ? null : deductionOf(e, gross);
  if (deduction == null && !issues.length) issues.push('공제액을 알 수 없음');
  const uniq = [...new Set(issues)];
  return { lines, gross: uniq.length ? (lines.every(l => l.amount != null) ? gross : null) : gross, deduction, net: uniq.length ? null : gross - deduction, issues: uniq };
}

// 확정된 급여 금액 (정산표·지급 예정이 모두 이 값을 씀)
export function runAmounts(run) {
  if (run.status !== 'confirmed') return null;
  return { gross: run.gross, deduction: run.deduction, net: run.net, days: run.days || [] };
}

// 같은 날 여러 일정 → 기본 1일. 일정 → 날짜별 묶음
export function eventsToDays(events, from, to) {
  const by = new Map();
  for (const ev of events) {
    const s = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10);
    let e = ev.end?.date ? addDays(ev.end.date, -1) : (ev.end?.dateTime || ev.start?.dateTime || '').slice(0, 10) || s;
    if (!s) continue;
    if (e < s) e = s;
    for (let d = s; d <= e && dayDiff(s, d) < 31; d = addDays(d, 1)) {
      if (d < from || d > to) continue;
      const x = by.get(d) || { date: d, kind: defaultDayKind(d), on: true, events: [] };
      x.events.push({ title: ev.summary || '(제목 없음)', place: ev.location || '' });
      by.set(d, x);
    }
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ───── 지급 상태 ─────
// 사용자 "지급 확인" / 은행 거래 대조 / 미확인(은행 자료 없음)
export function payState(M, run, e) {
  const amt = runAmounts(run);
  if (!amt) return { k: 'none', label: '' };
  const userPaid = (run.paid || []).reduce((s, p) => s + p.amount, 0);
  let bankPaid = 0; const txs = [];
  const name = normName(e?.holder || '');
  if (run.payDate && name) {
    for (const t of M.txns) {
      if (!(t.out > 0) || t.date < addDays(run.payDate, -3) || t.date > addDays(run.payDate, 10)) continue;
      if (!M.info.get(t.id).n.includes(name)) continue;
      bankPaid += t.out; txs.push(t);
      if (bankPaid >= amt.net) break;
    }
  }
  const hint = !txs.length && run.payDate ? M.txns.find(t => t.out === amt.net && Math.abs(dayDiff(run.payDate, t.date)) <= 5) : null;
  const paid = Math.max(userPaid, bankPaid);
  const remain = Math.max(0, amt.net - paid);
  const today = todayStr();
  if (bankPaid >= amt.net) return { k: 'bank', label: '은행 거래 대조 완료', paid: bankPaid, remain: 0, txs };
  if (userPaid >= amt.net) return { k: 'user', label: '지급 확인 (사용자 · 은행 대조 전)', paid: userPaid, remain: 0, txs };
  if (paid > 0) return { k: 'part', label: `일부 지급 ${paid.toLocaleString('ko-KR')} · 남은 ${remain.toLocaleString('ko-KR')}`, paid, remain, txs };
  if (run.payDate && run.payDate < today && !covered(M, '', run.payDate, run.payDate)) return { k: 'unverified', label: '미확인 (그 기간 은행 자료 없음)', paid: 0, remain, hint };
  if (run.payDate && run.payDate < today) return { k: 'unpaid', label: '지급 안 됨', paid: 0, remain, hint };
  return { k: 'due', label: run.payDate ? '지급 예정' : '지급일 미정', paid: 0, remain, hint };
}

// ───── 인건비(근무한 달) / 현금(이체한 달) ─────
export function laborByMonth() {
  const out = {};
  const add = (ym, v) => { out[ym] = (out[ym] || 0) + v; };
  for (const r of live('payruns')) {
    if (r.status !== 'confirmed') continue;
    if (r.days && r.days.length && r.type !== 'ledger') { for (const d of r.days) if (d.on !== false && Number.isSafeInteger(d.amount)) add(ymOf(d.date), d.amount); }
    else if (r.attrYm) add(r.attrYm, r.gross ?? r.net);
  }
  return out;
}

// ───── 월 마감 ─────
export const closeOf = ym => { const c = store.state.closes?.[ym]; return c && !c.deleted && c.closed ? c : null; };
export const isClosedDate = d => !!(d && closeOf(String(d).slice(0, 7)));
export function deviceName() {
  try { return localStorage.getItem('stube-device') || (/Android|iPhone|Mobile/i.test(navigator.userAgent) ? '휴대폰' : 'PC'); } catch { return 'PC'; }
}
export function audit(ym, action, before, after, reason = '') {
  put('audit', { id: uid('au'), ym, action, before, after, reason, at: nowTs(), by: deviceName() });
}
export function closeMonth(ym, snapshot) {
  put('closes', { id: ym, closed: true, at: nowTs(), by: deviceName(), snapshot });
  audit(ym, 'close', { closed: false }, { closed: true, ...snapshot });
}
export function reopenMonth(ym, reason) {
  const c = closeOf(ym);
  if (!c || !String(reason || '').trim()) return false;
  put('closes', { id: ym, closed: false, at: nowTs(), by: deviceName(), prev: { at: c.at, by: c.by } });
  audit(ym, 'reopen', { closed: true, at: c.at, by: c.by }, { closed: false }, reason.trim());
  return true;
}

// ───── 임금대장 엑셀 ─────
// 성명 + 차인지급액(실지급액·실수령액) 칸이 있는 표. 귀속월·지급일은 머리말에서 찾되, 없으면 비워둠 (추정하지 않음)
export function parseWageLedger(rows) {
  const t = v => String(v ?? '').trim();
  const k = v => t(v).replace(/\s+/g, '');
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const ks = (rows[i] || []).map(k);
    if (ks.some(x => /^(성명|사원명|이름|성명\(이름\))$/.test(x)) && ks.some(x => /차인지급액|실지급액|실수령액|차감지급액/.test(x))) { hi = i; break; }
  }
  if (hi < 0) return { error: '임금대장 형식을 찾지 못했습니다 (성명·차인지급액 칸이 있는 표)' };
  const ks = rows[hi].map(k);
  const ci = re => ks.findIndex(x => re.test(x));
  const c = { name: ci(/^(성명|사원명|이름|성명\(이름\))$/), net: ci(/차인지급액|실지급액|실수령액|차감지급액/), gross: ci(/^(지급총액|지급합계|급여총액|총지급액|지급액계)$/), ded: ci(/^(공제총액|공제합계|공제액계|총공제액)$/) };
  const head = rows.slice(0, hi).flat().map(t).join(' ');
  const am = head.match(/(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*월?\s*(귀속|분)/) || head.match(/귀속\s*(?:연월|년월)?\s*[:：]?\s*(20\d{2})\s*[년.\-/]\s*(\d{1,2})/);
  const pd = head.match(/지급\s*(?:일|일자)\s*[:：]?\s*(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/);
  const pad = n => String(n).padStart(2, '0');
  const toInt = v => { const s = String(v ?? '').replace(/[,\s원]/g, ''); return /^-?\d+$/.test(s) ? parseInt(s, 10) : (typeof v === 'number' && Number.isInteger(v) ? v : null); };
  const list = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = t(row[c.name]);
    if (!name || /^(합계|계|총계|소계)$/.test(name.replace(/\s+/g, ''))) continue;
    const net = toInt(row[c.net]);
    if (net == null) continue;
    list.push({ name, net, gross: c.gross >= 0 ? toInt(row[c.gross]) : null, deduction: c.ded >= 0 ? toInt(row[c.ded]) : null, row: r + 1 });
  }
  return { type: 'wage', attrYm: am ? `${am[1]}-${pad(am[2])}` : '', payDate: pd ? `${pd[1]}-${pad(pd[2])}-${pad(pd[3])}` : '', list };
}
