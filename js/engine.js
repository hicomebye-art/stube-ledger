// 계산 엔진: 잔액 검증, 중복·이중송금 검토, 세금계산서↔입출금 대조, 자금 계획
// 모든 계산은 정수 덧셈·뺄셈만 사용합니다 (오차 0원).
import { store, live } from './store.js';
import { todayStr, addDays, dayDiff, normName, nameMatch, ymOf, addMonths, daysInMonth } from './util.js';

const CARD_RE = /체크|카드|IC직불|현금IC|정정/;
const cmpTx = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.ord || 0) - (b.ord || 0));
const push = (map, k, v) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };

let cache = { rev: -1, m: null };
export function model() {
  if (cache.rev !== store.rev) cache = { rev: store.rev, m: build(store.state) };
  return cache.m;
}

function build(S) {
  const accounts = live('accounts').sort((a, b) => (a.order || 0) - (b.order || 0));
  const acctById = Object.fromEntries(accounts.map(a => [a.id, a]));
  const txns = live('txns').sort(cmpTx);
  const txById = new Map(txns.map(t => [t.id, t]));
  const owners = new Set(accounts.map(a => normName(a.owner || '')).filter(Boolean));
  const info = new Map(txns.map(t => { const n = normName(t.desc); return [t.id, { n, card: CARD_RE.test(t.method || ''), cancel: false, transfer: null, owner: owners.has(n) }]; }));
  const byAcct = {};
  for (const a of accounts) byAcct[a.id] = [];
  for (const t of txns) (byAcct[t.acct] ||= []).push(t);

  // 1) 카드 가승인 취소(정정) 짝 찾기: 음수 출금 ↔ 바로 앞의 같은 금액 출금
  for (const list of Object.values(byAcct)) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!(t.out < 0 || t.in < 0)) continue;
      const ti = info.get(t.id);
      for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
        const u = list[j], ui = info.get(u.id);
        if (ui.cancel || u.out <= 0 && u.in <= 0) continue;
        if (((t.out < 0 && u.out === -t.out) || (t.in < 0 && u.in === -t.in)) && ui.n === ti.n && Math.abs(dayDiff(u.date, t.date)) <= 1) {
          ti.cancel = true; ui.cancel = true; ti.pair = u.id; ui.pair = t.id; break;
        }
      }
    }
  }

  // 2) 잔액 연결 검증 (통장별, 시간순)
  const breaks = [];
  for (const [acct, list] of Object.entries(byAcct)) {
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1], c = list[i];
      const exp = p.bal + c.in - c.out;
      if (exp !== c.bal) breaks.push({ acct, prev: p, cur: c, expected: exp, diff: c.bal - exp });
    }
  }

  // 3) 내 통장끼리 이체 (같은 금액, 같은 날 또는 다음날, 다른 통장)
  const insByAmt = new Map();
  for (const t of txns) if (t.in > 0 && !info.get(t.id).cancel) push(insByAmt, t.in, t);
  for (const t of txns) {
    if (!(t.out > 0) || info.get(t.id).cancel || info.get(t.id).card) continue;
    const c = (insByAmt.get(t.out) || []).find(u => u.acct !== t.acct && !info.get(u.id).transfer && Math.abs(dayDiff(t.date, u.date)) <= 1);
    if (c) { info.get(t.id).transfer = c.id; info.get(c.id).transfer = t.id; }
  }

  // 4) 잔액 + 핸드폰 기록
  const manual = live('manual');
  const linked = new Set(manual.filter(m => m.linkTxn).map(m => m.linkTxn));
  const balances = {};
  for (const a of accounts) {
    const list = byAcct[a.id] || [];
    const last = list[list.length - 1];
    balances[a.id] = { bal: last ? last.bal : null, lastTs: last ? last.ts : '', lastDate: last ? last.date : '', pending: 0, pendingList: [] };
  }
  const manualSug = [], manualOrphan = [];
  for (const m of manual) {
    if (m.linkTxn) continue;
    const b = balances[m.acct];
    const cands = (byAcct[m.acct] || []).filter(t => t.out === m.amount && !linked.has(t.id) && Math.abs(dayDiff(m.date, t.date)) <= 3);
    if (cands.length) manualSug.push({ m, cands });
    else if (b && b.lastDate && m.date < b.lastDate) manualOrphan.push(m);
    else if (b) { b.pending += m.amount; b.pendingList.push(m); }
  }
  let total = 0, totalEst = 0;
  for (const a of accounts) {
    const b = balances[a.id];
    b.est = (b.bal || 0) - b.pending;
    total += b.bal || 0;
    totalEst += b.est;
  }

  const M = { S, accounts, acctById, txns, txById, info, byAcct, breaks, balances, total, totalEst, manual, manualSug, manualOrphan };
  M.inv = matchInvoices(S, M);
  M.review = buildReview(S, M);
  return M;
}

function inWindow(i, t) { const d = dayDiff(i.wdate, t.date); return d >= -10 && d <= 200; }

function subsetSum(items, target, val, maxK) {
  const arr = items.map(i => [i, val(i)]).filter(x => x[1] > 0 && x[1] <= target).sort((a, b) => b[1] - a[1]);
  let steps = 0;
  const pick = [];
  function dfs(start, rem) {
    if (rem === 0) return pick.length >= 2;
    if (pick.length >= maxK || ++steps > 400000) return false;
    for (let k = start; k < arr.length; k++) {
      if (arr[k][1] > rem) continue;
      pick.push(arr[k][0]);
      if (dfs(k + 1, rem - arr[k][1])) return true;
      pick.pop();
    }
    return false;
  }
  return dfs(0, target) ? pick.slice() : null;
}

function matchInvoices(S, M) {
  const invs = live('invoices');
  const byId = Object.fromEntries(invs.map(i => [i.id, i]));
  const st = {};
  for (const i of invs) st[i.id] = { state: 'open', eff: i.total, txns: [], how: '', date: '' };
  // 수정세금계산서는 원래 계산서 금액에 합칩니다
  for (const i of invs) if (i.orig && byId[i.orig] && i.orig !== i.id) { st[i.id].state = 'corr'; st[i.orig].eff += i.total; }

  const used = new Set();
  for (const i of invs) {
    const s = st[i.id];
    if (s.state === 'corr') continue;
    if (i.linkTxns && i.linkTxns.length) { Object.assign(s, { state: 'paid', how: 'manual', txns: i.linkTxns.slice() }); i.linkTxns.forEach(id => used.add(id)); const t = M.txById.get(i.linkTxns[0]); s.date = t ? t.date : ''; continue; }
    if (i.settled) { Object.assign(s, { state: 'paid', how: 'settled' }); continue; }
    if (s.eff <= 0) { s.state = 'cancel'; continue; }
    if (i.kind === 'purchase' && (/수입/.test(i.typ) || i.rc === '해당없음')) { s.state = 'na'; continue; }
  }

  const pool = M.txns.filter(t => { const f = M.info.get(t.id); return !f.cancel && !f.transfer && !used.has(t.id); });
  const inByAmt = new Map(), outByAmt = new Map();
  for (const t of pool) { if (t.in > 0) push(inByAmt, t.in, t); if (t.out > 0) push(outByAmt, t.out, t); }
  const nameOk = (t, i) => {
    const n = M.info.get(t.id).n;
    const a = S.aliases[n];
    if (a && !a.deleted) return a.biz === i.biz;
    if ((i.dom || []).some(d => n.includes(d))) return true; // 영문 입금자명 ↔ 계산서 이메일 도메인
    return nameMatch(t.desc, i.name);
  };
  const open = invs.filter(i => st[i.id].state === 'open').sort((a, b) => (a.wdate < b.wdate ? -1 : a.wdate > b.wdate ? 1 : 0));
  const autoOk = open.filter(i => !i.noAuto);

  // 1차: 같은 금액 + 거래처 이름 일치
  for (const i of autoOk) {
    const map = i.kind === 'sales' ? inByAmt : outByAmt;
    const t = (map.get(st[i.id].eff) || []).find(t => !used.has(t.id) && inWindow(i, t) && nameOk(t, i));
    if (t) { used.add(t.id); Object.assign(st[i.id], { state: 'paid', how: 'auto', txns: [t.id], date: t.date }); }
  }
  // 2차: 여러 장을 한 번에 입금/송금한 것 같은 경우 → 합계가 우연히 맞을 수 있어서 "후보"로만 보여주고 사람이 확정
  const groups = {};
  const groupSugg = [];
  const reserved = new Set();
  for (const i of autoOk) if (st[i.id].state === 'open') (groups[i.kind + '|' + i.biz] ||= []).push(i);
  for (const list of Object.values(groups)) {
    if (list.length < 2) continue;
    const kind = list[0].kind;
    const txs = pool.filter(t => !used.has(t.id) && (kind === 'sales' ? t.in > 0 : t.out > 0) && nameOk(t, list[0]));
    for (const t of txs) {
      const amt = kind === 'sales' ? t.in : t.out;
      const avail = list.filter(i => st[i.id].state === 'open' && !reserved.has(i.id) && inWindow(i, t)).slice(0, 18);
      if (avail.length < 2) continue;
      const pick = subsetSum(avail, amt, i => st[i.id].eff, 12);
      if (pick) { pick.forEach(i => reserved.add(i.id)); groupSugg.push({ t, kind, invs: pick }); }
    }
  }
  // 제안: 금액만 같은 거래 (사람이 확인)
  const sugg = {};
  for (const i of open) {
    if (st[i.id].state !== 'open') continue;
    const map = i.kind === 'sales' ? inByAmt : outByAmt;
    const c = (map.get(st[i.id].eff) || []).filter(t => !used.has(t.id) && inWindow(i, t));
    if (c.length) sugg[i.id] = c.slice(0, 3);
  }
  // 영수 계산서(이미 결제하고 받은 계산서)는 송금 내역이 없어도 미지급으로 보지 않음
  for (const i of open) if (st[i.id].state === 'open' && i.kind === 'purchase' && i.rc === '영수' && !sugg[i.id]) st[i.id].state = 'receipt';
  const txInv = new Map();
  for (const i of invs) for (const id of st[i.id].txns) push(txInv, id, i.id);
  return { list: invs, byId, st, sugg, groupSugg, txInv };
}

function buildReview(S, M) {
  const items = [];
  const dec = S.decisions;
  const add = it => { it.dismissed = !!(dec[it.key] && !dec[it.key].deleted); items.push(it); };
  const today = todayStr();

  for (const b of M.breaks) {
    add({ key: `bal:${b.prev.id}:${b.cur.id}`, type: 'balance', sev: 3, acct: b.acct, rows: [b.prev, b.cur], expected: b.expected, diff: b.diff });
  }

  // 같은 날 같은 내용·금액 2건 이상 (1만원 이상)
  const dup = new Map();
  for (const t of M.txns) {
    const f = M.info.get(t.id);
    if (f.cancel || Math.max(t.in, t.out) < 10000) continue;
    push(dup, [t.acct, t.date, f.n, t.in, t.out].join('|'), t);
  }
  for (const list of dup.values()) if (list.length >= 2) add({ key: 'dup:' + list.map(t => t.id).join(':'), type: 'dup', sev: 2, rows: list });

  // 같은 곳에 같은 금액을 20일 안에 두 번 보냄 (10만원 이상, 카드·내 통장 이체 제외)
  // 제외: 카드, 내 통장 이체, 대표 본인 계좌, 각각 다른 계산서와 연결된 송금, 주기적으로 반복되는 송금(60일 안 3번 이상)
  const dbl = new Map();
  for (const t of M.txns) {
    const f = M.info.get(t.id);
    if (!(t.out >= 100000) || f.cancel || f.card || f.transfer || f.owner) continue;
    push(dbl, f.n + '|' + t.out, t);
  }
  for (const list of dbl.values()) {
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1], b = list[k];
      const d = dayDiff(a.date, b.date);
      if (d > 20 || (d === 0 && a.acct === b.acct)) continue;
      if (M.inv.txInv.has(a.id) && M.inv.txInv.has(b.id)) continue;
      const near = list.filter(t => Math.abs(dayDiff(a.date, t.date)) <= 60).length;
      if (near >= 3) continue;
      add({ key: `dbl:${a.id}:${b.id}`, type: 'dbl', sev: 3, rows: [a, b], days: d });
    }
  }

  for (const s of M.manualSug) add({ key: 'mlink:' + s.m.id, type: 'mlink', sev: 1, m: s.m, rows: s.cands });
  for (const m of M.manualOrphan) add({ key: 'morph:' + m.id, type: 'morph', sev: 2, m });

  // 계산서 ↔ 입출금
  const { list, st, sugg, groupSugg } = M.inv;
  const inGroup = new Set();
  for (const g of groupSugg) {
    add({ key: 'grp:' + g.t.id, type: 'group', sev: 2, t: g.t, kind: g.kind, invs: g.invs });
    g.invs.forEach(i => inGroup.add(i.id));
  }
  for (const i of list) {
    const s = st[i.id];
    if (s.state !== 'open' || inGroup.has(i.id)) continue;
    const age = dayDiff(i.wdate, today);
    const limit = i.kind === 'sales' ? 45 : 30;
    if (age >= limit || sugg[i.id]) add({ key: `inv:${i.id}`, type: i.kind === 'sales' ? 'unpaidSales' : 'unpaidPurchase', sev: age > 90 ? 3 : 2, inv: i, age, eff: s.eff, sugg: sugg[i.id] || [] });
  }
  // 계산서 없는 입금 (30만원 이상, 세금계산서 자료가 있는 기간만)
  const salesDates = list.filter(i => i.kind === 'sales').map(i => i.wdate).sort();
  if (salesDates.length) {
    const startD = salesDates[0];
    for (const t of M.txns) {
      const f = M.info.get(t.id);
      if (!(t.in >= 300000) || f.cancel || f.transfer || f.owner || t.date < startD) continue;
      if (M.inv.txInv.has(t.id) || groupSugg.some(g => g.t.id === t.id) || /이자|결산|캐쉬백|환급|정정/.test(t.desc + t.method)) continue;
      add({ key: 'noinv:' + t.id, type: 'noinv', sev: 1, rows: [t] });
    }
  }
  return items;
}

export const REVIEW_TYPES = {
  balance: '잔액이 이어지지 않음',
  dup: '같은 날 같은 거래가 2건 이상 (중복 의심)',
  dbl: '같은 곳에 같은 금액을 두 번 보냄 (이중 송금 의심)',
  group: '계산서 여러 장을 한 번에 입금·송금한 것 같음 (맞는지 확인)',
  mlink: '핸드폰 기록과 통장 거래가 같은 것 같음',
  morph: '통장에서 찾지 못한 핸드폰 기록',
  unpaidSales: '매출 계산서는 발행했는데 입금이 안 보임 (미수금)',
  unpaidPurchase: '매입 계산서는 받았는데 송금이 안 보임 (미지급)',
  noinv: '세금계산서 없는 입금',
};

// ───────── 자금 계획 ─────────
function bankHit(M, kind, amount, date, acct) {
  return M.txns.find(t => (kind === 'out' ? t.out === amount : t.in === amount) && (!acct || t.acct === acct) && Math.abs(dayDiff(date, t.date)) <= 5);
}

export function vatPeriods(S, M) {
  const per = {};
  for (const i of M.inv.list) {
    const y = i.wdate.slice(0, 4), h = Number(i.wdate.slice(5, 7)) <= 6 ? 'H1' : 'H2';
    const k = `${y}-${h}`;
    const p = (per[k] ||= { key: k, y: +y, h, salesTax: 0, purchTax: 0, salesSupply: 0, purchSupply: 0, n: 0 });
    if (i.kind === 'sales') { p.salesTax += i.tax; p.salesSupply += i.supply; } else { p.purchTax += i.tax; p.purchSupply += i.supply; }
    p.n++;
  }
  for (const p of Object.values(per)) {
    p.due = p.h === 'H1' ? `${p.y}-07-25` : `${p.y + 1}-01-25`;
    p.prepaid = Number(S.settings.vatPrepaid?.[p.key] || 0);
    p.est = p.salesTax - p.purchTax - p.prepaid;
    p.label = `${p.y}년 ${p.h === 'H1' ? '1기 (1~6월)' : '2기 (7~12월)'}`;
  }
  return Object.values(per).sort((a, b) => (a.key < b.key ? 1 : -1));
}

// from~to 사이의 예정 항목 (지난 미완료 항목은 overdue)
export function occurrences(S, M, from, to) {
  const out = [];
  const curYm = ymOf(from);
  for (const p of live('plans')) {
    if (p.skipped) continue;
    let done = !!p.done;
    if (!done && p.invoiceId && M.inv.st[p.invoiceId]?.state === 'paid') done = true;
    if (p.date >= from && p.date <= to) out.push({ key: p.id, src: 'plan', planId: p.id, recId: p.recId || '', date: p.date, kind: p.kind, amount: p.amount, title: p.title, acct: p.acct || '', cat: p.cat || '', personal: !!p.personal, done, overdue: false });
    else if (!done && p.date < from) out.push({ key: p.id, src: 'plan', planId: p.id, recId: p.recId || '', date: p.date, kind: p.kind, amount: p.amount, title: p.title, acct: p.acct || '', cat: p.cat || '', personal: !!p.personal, done, overdue: true });
  }
  for (const r of live('recurring')) {
    if (r.active === false) continue;
    let ym = r.startYm && r.startYm > curYm ? r.startYm : curYm;
    for (let guard = 0; guard < 40 && ym <= ymOf(to); guard++, ym = addMonths(ym, 1)) {
      if (r.endYm && ym > r.endYm) break;
      const day = Math.min(Number(r.day) || 1, daysInMonth(ym));
      const date = `${ym}-${String(day).padStart(2, '0')}`;
      const key = `${r.id}:${ym}`;
      if (S.plans[key]) continue; // 완료 체크했거나 이번 달 건너뜀
      const base = { key, src: 'rec', recId: r.id, ym, date, kind: r.kind || 'out', amount: r.amount, title: r.title, acct: r.acct || '', cat: r.cat || 'fixed', personal: !!r.personal, done: false, overdue: false };
      if (date < from) {
        if (bankHit(M, base.kind, base.amount, date, base.acct)) continue; // 통장에 이미 나감
        out.push({ ...base, overdue: true });
      } else if (date <= to) out.push(base);
    }
  }
  for (const p of vatPeriods(S, M)) {
    if (p.est > 0 && p.due >= from && p.due <= to) out.push({ key: 'vat:' + p.key, src: 'vat', date: p.due, kind: 'out', amount: p.est, title: `부가세 ${p.label} (계산서 기준 예상)`, acct: '', cat: 'tax', personal: false, done: false, overdue: false });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === 'out' ? -1 : 1) - (b.kind === 'out' ? -1 : 1)));
}

export function projection(S, M, days) {
  const from = todayStr(), to = addDays(from, days);
  const evs = occurrences(S, M, from, to).filter(o => !o.done && (S.settings.includePersonal || !o.personal));
  let bal = M.totalEst, inSum = 0, outSum = 0;
  const pts = [{ date: from, bal }];
  let min = { bal, date: from };
  for (const e of evs) {
    const d = e.date < from ? from : e.date;
    if (e.kind === 'in') { bal += e.amount; inSum += e.amount; } else { bal -= e.amount; outSum += e.amount; }
    e.after = bal; e.at = d;
    pts.push({ date: d, bal });
    if (bal < min.bal) min = { bal, date: d };
  }
  return { from, to, days, start: M.totalEst, evs, pts, min, end: bal, inSum, outSum };
}

export function planHint(M, o) {
  if (o.done || o.src === 'vat') return null;
  return bankHit(M, o.kind, o.amount, o.date, o.acct) || null;
}

// ───────── 카드 사용 ─────────
export function cardUsage(M) {
  const res = {};
  for (const t of M.txns) {
    const f = M.info.get(t.id);
    if (f.transfer) continue;
    const r = ((res[t.acct] ||= {})[ymOf(t.date)] ||= { card: 0, cardN: 0, out: 0 });
    if (f.card) { r.card += t.out - t.in; if (!f.cancel) r.cardN++; }
    r.out += t.out;
  }
  return res;
}

export function cardMerchants(M, acct, ym) {
  const g = new Map();
  for (const t of M.byAcct[acct] || []) {
    const f = M.info.get(t.id);
    if (!f.card || ymOf(t.date) !== ym) continue;
    const r = g.get(f.n) || { name: t.desc, amount: 0, n: 0 };
    r.amount += t.out - t.in; if (!f.cancel) r.n++;
    g.set(f.n, r);
  }
  return [...g.values()].filter(r => r.amount !== 0).sort((a, b) => b.amount - a.amount);
}

// ───────── 고정 지출 추천 ─────────
export function recurringSuggestions(S, M) {
  const have = live('recurring').map(r => normName(r.title));
  const g = new Map();
  const since = addDays(todayStr(), -200);
  for (const t of M.txns) {
    const f = M.info.get(t.id);
    if (!(t.out > 0) || f.card || f.transfer || f.cancel || t.date < since) continue;
    push(g, f.n, t);
  }
  const res = [];
  for (const [n, list] of g) {
    if (!n || have.some(h => h && (h.includes(n) || n.includes(h)))) continue;
    const months = new Set(list.map(t => ymOf(t.date)));
    if (months.size < 3) continue;
    const last = list[list.length - 1];
    const amts = list.map(t => t.out).sort((a, b) => a - b);
    const med = amts[Math.floor(amts.length / 2)];
    const steady = list.filter(t => Math.abs(t.out - med) <= med * 0.1).length >= Math.min(3, months.size);
    if (!steady) continue;
    const days = list.map(t => Number(t.date.slice(8))).sort((a, b) => a - b);
    // 수협은 받는 분 이름 앞에 은행 번호(예: 090)를 붙여 보내므로 화면용 이름에서는 뗍니다.
    const title = last.acct === 'suhyup' ? String(last.desc).replace(/^\d{2,4}(?=\D)/, '') : last.desc;
    res.push({ title, amount: last.out, day: days[Math.floor(days.length / 2)], acct: last.acct, months: months.size });
  }
  return res.sort((a, b) => b.amount - a.amount);
}

// ───────── 거래처 ─────────
export function partners(M) {
  const p = new Map();
  for (const i of M.inv.list) {
    const s = M.inv.st[i.id];
    const r = p.get(i.biz) || { biz: i.biz, name: i.name, sales: 0, purchase: 0, recv: 0, pay: 0, n: 0, last: '' };
    if (i.kind === 'sales') r.sales += i.total; else r.purchase += i.total;
    if (s.state === 'open') { if (i.kind === 'sales') r.recv += s.eff; else r.pay += s.eff; }
    r.n++;
    if (i.wdate > r.last) { r.last = i.wdate; r.name = i.name; }
    p.set(i.biz, r);
  }
  return [...p.values()].sort((a, b) => (b.sales + b.purchase) - (a.sales + a.purchase));
}
