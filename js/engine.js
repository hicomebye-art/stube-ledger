// 계산 엔진: 잔액 검증, 중복·이중송금 검토, 세금계산서↔입출금 대조, 자금 계획
// 모든 계산은 정수 덧셈·뺄셈만 사용합니다 (오차 0원).
import { store, live } from './store.js';
import { todayStr, addDays, dayDiff, normName, nameMatch, ymOf, addMonths, daysInMonth } from './util.js';
import { taxStates } from './tax.js';
import { payState } from './payroll.js';

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
  // 금액만 같다고 이체로 빼지 않습니다. 보낸 쪽·받은 쪽 이름이 예금주(대표)이거나 사람이 "맞음"으로 확인한 경우만 이체로 봅니다.
  // 이름 근거가 없으면 이체 "후보"로만 두고 검토에 올립니다 (매출·비용에서 빠지지 않음).
  const dec = S.decisions || {};
  const yes = id => dec['xferYes:' + id] && !dec['xferYes:' + id].deleted;
  const insByAmt = new Map();
  for (const t of txns) if (t.in > 0 && !info.get(t.id).cancel) push(insByAmt, t.in, t);
  for (const t of txns) {
    const ti = info.get(t.id);
    if (!(t.out > 0) || ti.cancel || ti.card) continue;
    const cs = (insByAmt.get(t.out) || []).filter(u => u.acct !== t.acct && !info.get(u.id).transfer && !info.get(u.id).xferCand && Math.abs(dayDiff(t.date, u.date)) <= 1);
    if (!cs.length) continue;
    const named = cs.find(u => ti.owner || info.get(u.id).owner);
    const c = named || (yes(t.id) ? cs[0] : null);
    if (c) { ti.transfer = c.id; info.get(c.id).transfer = t.id; }
    else { ti.xferCand = cs[0].id; info.get(cs[0].id).xferCand = t.id; }
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
  M.cov = coverage(accounts, byAcct);
  M.inv = matchInvoices(S, M);
  M.review = buildReview(S, M);
  return M;
}

// ───────── 은행 자료가 있는 기간 ─────────
// 통장마다 가져온 파일의 기간을 이어 붙입니다. 자료가 없는 날의 거래는 "미확인"으로 보고, 미지급으로 단정하지 않습니다.
function coverage(accounts, byAcct) {
  const res = {};
  for (const a of accounts) {
    const iv = live('imports').filter(i => i.type === 'bank' && i.acct === a.id && i.from && i.to).map(i => [i.from.slice(0, 10), i.to.slice(0, 10)]);
    const list = byAcct[a.id] || [];
    if (!iv.length && list.length) iv.push([list[0].date, list[list.length - 1].date]);
    iv.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const merged = [];
    for (const [f, t] of iv) {
      const last = merged[merged.length - 1];
      if (last && f <= addDays(last[1], 1)) { if (t > last[1]) last[1] = t; } else merged.push([f, t]);
    }
    res[a.id] = merged;
  }
  return res;
}

// from~to 전체가 은행 자료로 확인되는지. 통장을 모르면 자료가 있는 모든 통장이 그 기간을 가져야 합니다.
export function covered(M, acct, from, to) {
  const has = id => (M.cov[id] || []).some(([f, t]) => f <= from && to <= t);
  if (acct) return has(acct);
  const withData = M.accounts.filter(a => (M.cov[a.id] || []).length);
  return withData.length > 0 && withData.every(a => has(a.id));
}

export function lastCovered(M, acct) {
  const iv = M.cov[acct] || [];
  return iv.length ? iv[iv.length - 1][1] : '';
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
  // paid: 연결된 거래로 받은(보낸) 금액, remain: 남은 금액, alloc: 거래별 배분 금액
  for (const i of invs) st[i.id] = { state: 'open', eff: i.total, txns: [], alloc: [], paid: 0, remain: 0, how: '', date: '' };
  // 수정세금계산서는 원래 계산서 금액에 합칩니다
  for (const i of invs) if (i.orig && byId[i.orig] && i.orig !== i.id) { st[i.id].state = 'corr'; st[i.orig].eff += i.total; }

  const used = new Set();
  const txLeft = new Map(); // 거래마다 아직 계산서에 나눠주지 않은 금액
  const amtOf = (t, kind) => (kind === 'sales' ? t.in : t.out);
  const leftOf = (t, kind) => (txLeft.has(t.id) ? txLeft.get(t.id) : amtOf(t, kind));
  const byDate = (a, b) => (a.wdate < b.wdate ? -1 : a.wdate > b.wdate ? 1 : 0);

  // 사람이 연결한 거래: 거래 금액을 계산서 날짜 순으로 나눠 배분합니다.
  // 다 채워졌을 때만 "완료", 일부만 들어왔으면 "일부" + 남은 금액
  const linkedInvs = invs.filter(i => st[i.id].state !== 'corr' && !i.settled && ((i.links && i.links.length) || (i.linkTxns && i.linkTxns.length))).sort(byDate);
  for (const i of linkedInvs) {
    const s = st[i.id];
    const links = i.links && i.links.length ? i.links : i.linkTxns.map(t => ({ t, amt: null }));
    for (const l of links) {
      const t = M.txById.get(l.t);
      if (!t) continue;
      const have = leftOf(t, i.kind), want = s.eff - s.paid;
      const a = Math.min(have, l.amt != null ? l.amt : want);
      used.add(t.id);
      if (a <= 0) continue;
      txLeft.set(t.id, have - a);
      s.paid += a; s.txns.push(t.id); s.alloc.push({ t: t.id, amt: a });
      if (t.date > s.date) s.date = t.date;
    }
    s.how = 'manual';
    s.state = s.paid >= s.eff ? 'paid' : s.paid > 0 ? 'partial' : 'open';
  }
  // 거래처 화면의 "지급 기록" (실제로 보낸 뒤 사람이 적은 것): 계산서별로 나눈 금액을 그대로 더함.
  // 그 지급과 같은 통장 출금(합쳐졌거나, 합칠 후보)은 다른 계산서에 자동으로 다시 붙지 않게 막음 → 같은 돈 두 번 안 잡힘
  const payTx = new Map();
  for (const p of live('paylogs')) {
    for (const a of p.alloc || []) {
      const s = st[a.inv];
      if (!s || s.state === 'corr' || !(a.amt > 0)) continue;
      s.paid += a.amt;
      (s.pays ||= []).push({ id: p.id, amt: a.amt, date: p.date });
      if (p.date > s.date) s.date = p.date;
      if (s.how !== 'manual') s.how = 'paylog';
    }
    const m = M.manual.find(x => x.id === p.manualId);
    // 합쳐진 출금 → 같은 통장 후보 → (통장을 잘못 골랐을 때) 다른 통장의 같은 금액·같은 이름·3일 안 출금
    const t = m && m.linkTxn ? M.txById.get(m.linkTxn)
      : (M.manualSug.find(x => x.m.id === p.manualId)?.cands || []).find(c => !used.has(c.id))
      || M.txns.find(c => c.out === p.total && !used.has(c.id) && Math.abs(dayDiff(c.date, p.date)) <= 3 && nameMatch(c.desc, p.name) && !M.info.get(c.id).cancel);
    if (t) { used.add(t.id); txLeft.set(t.id, Math.max(0, leftOf(t, 'purchase') - p.total)); payTx.set(t.id, p.id); }
  }
  for (const i of invs) { const s = st[i.id]; if (s.pays && s.state !== 'corr') s.state = s.paid >= s.eff ? 'paid' : 'partial'; }
  for (const i of invs) {
    const s = st[i.id];
    if (s.state === 'corr' || s.how === 'manual' || s.how === 'paylog') continue;
    if (i.settled) { Object.assign(s, { state: 'paid', how: 'settled', paid: s.eff }); continue; }
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
    if (t) { used.add(t.id); txLeft.set(t.id, 0); Object.assign(st[i.id], { state: 'paid', how: 'auto', txns: [t.id], alloc: [{ t: t.id, amt: st[i.id].eff }], paid: st[i.id].eff, date: t.date }); }
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
  // 남은 금액
  for (const i of invs) { const s = st[i.id]; s.remain = s.state === 'open' || s.state === 'partial' ? Math.max(0, s.eff - s.paid) : 0; }
  // 제안: 남은 금액과 같은 거래 (사람이 확인). 일부만 들어온 계산서는 잔액과 같은 거래를 찾습니다.
  const sugg = {};
  const openOrPart = invs.filter(i => st[i.id].state === 'open' || st[i.id].state === 'partial').sort(byDate);
  for (const i of openOrPart) {
    const map = i.kind === 'sales' ? inByAmt : outByAmt;
    const c = (map.get(st[i.id].remain) || []).filter(t => !used.has(t.id) && inWindow(i, t));
    if (c.length) sugg[i.id] = c.slice(0, 3);
  }
  // 일부 입금·송금 후보: 거래처 이름이 같고 금액이 잔액보다 작은 거래 (나눠서 들어온 돈)
  const partSugg = {};
  for (const i of openOrPart) {
    const s = st[i.id];
    const c = pool.filter(t => !used.has(t.id) && inWindow(i, t) && amtOf(t, i.kind) > 0 && amtOf(t, i.kind) < s.remain && nameOk(t, i));
    if (c.length) partSugg[i.id] = c.slice(0, 4);
  }
  // 영수 계산서(이미 결제하고 받은 계산서)는 송금 내역이 없어도 미지급으로 보지 않음
  for (const i of open) if (st[i.id].state === 'open' && i.kind === 'purchase' && i.rc === '영수' && !sugg[i.id] && !partSugg[i.id]) { st[i.id].state = 'receipt'; st[i.id].remain = 0; }
  const txInv = new Map();
  for (const i of invs) for (const id of st[i.id].txns) push(txInv, id, i.id);
  return { list: invs, byId, st, sugg, partSugg, groupSugg, txInv, txLeft, leftOf, payTx };
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

  // 내 통장끼리 이체 후보 (이름 근거 없음 → 사람이 확인)
  for (const t of M.txns) {
    const f = M.info.get(t.id);
    if (t.out > 0 && f.xferCand && !f.transfer) add({ key: 'xfer:' + t.id, type: 'xfer', sev: 1, rows: [t, M.txById.get(f.xferCand)] });
  }

  for (const s of M.manualSug) add({ key: 'mlink:' + s.m.id, type: 'mlink', sev: 1, m: s.m, rows: s.cands });
  for (const m of M.manualOrphan) add({ key: 'morph:' + m.id, type: 'morph', sev: 2, m });

  // 계산서 ↔ 입출금
  const { list, st, sugg, partSugg, groupSugg } = M.inv;
  const inGroup = new Set();
  for (const g of groupSugg) {
    add({ key: 'grp:' + g.t.id, type: 'group', sev: 2, t: g.t, kind: g.kind, invs: g.invs });
    g.invs.forEach(i => inGroup.add(i.id));
  }
  for (const i of list) {
    const s = st[i.id];
    if ((s.state !== 'open' && s.state !== 'partial') || inGroup.has(i.id)) continue;
    const age = dayDiff(i.wdate, today);
    const limit = i.kind === 'sales' ? 45 : 30;
    if (age >= limit || sugg[i.id] || partSugg[i.id] || s.state === 'partial') add({ part: partSugg[i.id] || [], key: s.paid ? `inv:${i.id}:${s.paid}` : `inv:${i.id}`, type: i.kind === 'sales' ? 'unpaidSales' : 'unpaidPurchase', sev: age > 90 ? 3 : 2, inv: i, age, eff: s.remain, total: s.eff, paid: s.paid, sugg: sugg[i.id] || [] });
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
  xfer: '내 통장끼리 이체인지 확인 (금액만 같음)',
  group: '계산서 여러 장을 한 번에 입금·송금한 것 같음 (맞는지 확인)',
  mlink: '핸드폰 기록과 통장 거래가 같은 것 같음',
  morph: '통장에서 찾지 못한 핸드폰 기록',
  unpaidSales: '매출 계산서는 발행했는데 입금이 안 보임 (미수금)',
  unpaidPurchase: '매입 계산서는 받았는데 송금이 안 보임 (미지급)',
  noinv: '세금계산서 없는 입금',
};

// ───────── 자금 계획 ─────────
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

// ───────── 예정 항목 ─────────
// 출금 방식(pay): direct 직접 보냄 / auto 자동이체 / card 카드 자동결제
// 입금 구분(conf): confirmed 확정 수금 / expected 예상 수금 (예상은 가용자금에 넣지 않음)
export const PAY = { direct: '직접', auto: '자동이체', card: '카드결제' };

// 예정 항목과 같은 통장 거래 찾기
// - 통장 표시 이름(bankName)이 있으면: 이름이 같고 날짜가 -5일~+10일이면 금액이 달라도 같은 건 (실제 금액을 따로 보여줌)
// - 없으면: 금액이 정확히 같고 날짜가 ±5일
function matchCands(M, o, used, hiDays) {
  const name = normName(o.bankName || '');
  const lo = addDays(o.date, -5), hi = addDays(o.date, hiDays);
  const k = o.kind === 'in' ? 'in' : 'out';
  const res = [];
  for (const t of M.txns) {
    if (t.date < lo || t.date > hi || used.has(t.id) || !(t[k] > 0)) continue;
    if (o.acct && t.acct !== o.acct) continue;
    const f = M.info.get(t.id);
    if (f.cancel || f.transfer) continue;
    if (name ? !f.n.includes(name) : t[k] !== o.amount) continue;
    res.push(t);
  }
  return res;
}
function matchTx(M, o, used) {
  if (!o.date) return null;
  const c = matchCands(M, o, used, normName(o.bankName || '') ? 10 : 5);
  c.sort((a, b) => Math.abs(dayDiff(o.date, a.date)) - Math.abs(dayDiff(o.date, b.date)));
  return c[0] || null;
}

// from~to 사이의 예정 항목 (지난 미완료 항목은 overdue, 날짜 없는 항목은 noDate)
export function occurrences(S, M, from, to) {
  const out = [];
  const curYm = ymOf(from);
  const recOf = id => (id && S.recurring[id] && !S.recurring[id].deleted ? S.recurring[id] : null);
  let taxSt = null;
  for (const p of live('plans')) {
    if (p.skipped) continue;
    const r = recOf(p.recId);
    const kind = p.kind || 'out';
    const o = {
      key: p.id, src: 'plan', planId: p.id, recId: p.recId || '', ym: p.ym || '', date: p.date || '', kind, amount: p.amount, title: p.title,
      acct: p.acct || '', cat: p.cat || '', personal: !!p.personal, invoiceId: p.invoiceId || '',
      pay: kind === 'in' ? '' : (p.pay || r?.pay || 'direct'),
      conf: kind === 'in' ? (p.conf || r?.conf || (p.recId ? 'confirmed' : 'expected')) : '',
      bankName: p.bankName ?? r?.bankName ?? '',
      done: !!p.done, doneBy: p.done ? (p.doneBy || 'user') : '', noDate: !p.date, overdue: false,
    };
    if (!o.done && p.invoiceId && M.inv.st[p.invoiceId]?.state === 'paid') { o.done = true; o.doneBy = 'invoice'; }
    // 세무자료(원천세 납부서)에서 넣은 계획: 그 세금의 납부가 확인되면 완료
    if (!o.done && p.taxDocId) {
      taxSt = taxSt || taxStates(M);
      const k = taxSt.get(p.taxDocId)?.k;
      if (k && k !== 'unknown') { o.done = true; o.doneBy = 'tax'; }
    }
    if (o.noDate) { if (!o.done) out.push(o); continue; }
    if (p.date >= from && p.date <= to) out.push(o);
    else if (!o.done && p.date < from) out.push({ ...o, overdue: true });
  }
  for (const r of live('recurring')) {
    if (r.active === false) continue;
    let ym = r.startYm && r.startYm > curYm ? r.startYm : curYm;
    for (let guard = 0; guard < 40 && ym <= ymOf(to); guard++, ym = addMonths(ym, 1)) {
      if (r.endYm && ym > r.endYm) break;
      const day = Math.min(Number(r.day) || 1, daysInMonth(ym));
      const date = `${ym}-${String(day).padStart(2, '0')}`;
      const key = `${r.id}:${ym}`;
      if (S.plans[key] && !S.plans[key].deleted) continue; // 이번 달만 바꾼 값·완료·건너뜀은 plans 쪽에서 나옵니다
      const kind = r.kind || 'out';
      const o = {
        key, src: 'rec', recId: r.id, ym, date, kind, amount: r.amount, title: r.title, acct: r.acct || '', cat: r.cat || 'fixed', personal: !!r.personal,
        pay: kind === 'in' ? '' : (r.pay || 'direct'), conf: kind === 'in' ? (r.conf || 'confirmed') : '', bankName: r.bankName || '',
        done: false, doneBy: '', noDate: false, overdue: date < from,
      };
      if (date <= to) out.push(o);
    }
  }
  // 확정한 급여·주급 (확정 전 급여는 지급 예정 합계에 넣지 않음)
  for (const r of live('payruns')) {
    if (r.status !== 'confirmed' || !(r.net > 0)) continue;
    const e = S.employees?.[r.empId];
    const ps = payState(M, r, e);
    const o = {
      key: 'pay:' + r.id, src: 'pay', runId: r.id, date: r.payDate || '', kind: 'out', amount: r.net,
      title: `${r.type === 'weekly' ? '주급' : '급여'} ${e && !e.deleted ? e.name : ''}`.trim(), acct: '', cat: 'salary', personal: false,
      pay: 'direct', conf: '', bankName: '', done: ps.k === 'bank' || ps.k === 'user', doneBy: ps.k === 'bank' ? 'paybank' : ps.k === 'user' ? 'user' : '',
      noDate: !r.payDate, overdue: false,
    };
    if (ps.k === 'part') { o.paid = ps.paid; o.remain = ps.remain; o.partial = 'pay'; }
    if (o.noDate) { if (!o.done) out.push(o); }
    else if (o.date >= from && o.date <= to) out.push(o);
    else if (o.date < from && !o.done) out.push({ ...o, overdue: true, chk: ps.k === 'unverified' ? 'unverified' : ps.k === 'unpaid' ? 'missing' : undefined });
  }
  for (const p of vatPeriods(S, M)) {
    if (p.est > 0 && p.due >= from && p.due <= to) out.push({ key: 'vat:' + p.key, src: 'vat', date: p.due, kind: 'out', amount: p.est, title: `부가세 ${p.label} (계산서 기준 예상)`, acct: '', cat: 'tax', personal: false, pay: 'direct', conf: '', bankName: '', done: false, doneBy: '', noDate: false, overdue: false });
  }

  // 통장 대조: 은행에서 확인되면 "대조 완료", 사람이 체크만 했으면 "사용자 확인"
  // 금액이 다 채워졌을 때만 완료. 일부만 들어오면 "일부" + 남은 금액(remain)
  const today = todayStr();
  const used = new Set();
  const planOf = o => (o.src === 'plan' ? S.plans[o.planId] : null);
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const o of out) {
    if (o.noDate || o.src === 'vat' || o.src === 'pay') continue; // 급여는 급여 화면의 지급 상태를 그대로 씀
    const k = o.kind === 'in' ? 'in' : 'out';
    // 세금계산서에 연결된 예정: 계산서 대조 결과를 그대로 씀
    if (o.invoiceId && M.inv.st[o.invoiceId]) {
      const s = M.inv.st[o.invoiceId];
      if (s.state === 'partial') { o.paid = s.paid; o.remain = s.remain; o.partial = 'invoice'; }
    } else if (o.kind === 'out' && o.pay !== 'direct') {
      // 자동이체·카드: 한 건 찾으면 그 달 출금으로 확정 (금액은 달마다 다를 수 있음 → 실제 금액과 차이 표시)
      const t = matchTx(M, o, used);
      if (t) { used.add(t.id); o.tx = t; o.txs = [t]; o.actual = t.out; o.diff = o.actual - o.amount; o.done = true; o.doneBy = 'bank'; continue; }
    } else if (normName(o.bankName || '')) {
      // 직접 지급·수금 + 통장 표시 이름: 같은 이름 거래를 모아서 금액이 다 찼을 때만 완료
      const c = matchCands(M, o, used, 20).sort((a, b) => (a.ts < b.ts ? -1 : 1));
      let sum = 0; const pick = [];
      for (const t of c) { if (sum >= o.amount) break; pick.push(t); sum += t[k]; }
      if (pick.length) {
        pick.forEach(t => used.add(t.id));
        o.txs = pick; o.tx = pick[pick.length - 1]; o.paid = sum;
        if (sum >= o.amount) { o.actual = sum; o.diff = sum - o.amount; o.done = true; o.doneBy = 'bank'; continue; }
        o.remain = o.amount - sum; o.partial = 'bank';
      }
    } else {
      // 이름 없이 금액만 같은 거래는 "확인" 힌트만 (같은 금액이라고 완료로 보지 않음)
      const t = matchTx(M, o, used);
      if (t) o.hint = t;
    }
    // 사람이 입력한 일부 지급·수금 (은행 대조 전)
    const pp = Number(planOf(o)?.partPaid || 0);
    if (!o.done && pp > (o.paid || 0)) { o.paid = pp; o.remain = Math.max(0, o.amount - pp); o.partial = 'user'; }
    if (o.done || o.date >= today) continue;
    // 예정일이 지났는데 안 끝난 건: 은행 자료가 그 기간을 덮으면 "통장에 없음", 아니면 "미확인"
    const need = addDays(o.date, o.kind === 'out' && o.pay !== 'direct' ? 3 : 0);
    const end = need < today ? need : addDays(today, -1);
    o.chk = o.hint ? 'seen' : covered(M, o.acct, o.date, end < o.date ? o.date : end) ? 'missing' : 'unverified';
  }
  return out.sort((a, b) => (a.noDate !== b.noDate ? (a.noDate ? 1 : -1) : a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === 'out' ? -1 : 1) - (b.kind === 'out' ? -1 : 1)));
}

// 아직 남은 금액 (일부만 지급·수금됐으면 잔액)
export const left = o => (o.remain != null ? o.remain : o.amount);

// 기간별 할 일: 직접 보낼 돈 / 자동으로 나갈 돈 / 받을 돈(확정·예상) / 날짜 확인 필요
export function dayPlan(S, M, from, to, opts = {}) {
  let list = occurrences(S, M, from, to).filter(o => S.settings.includePersonal || !o.personal);
  if (opts.noOverdue) list = list.filter(o => o.noDate || o.date >= from);
  const r = { from, to, direct: [], auto: [], inConf: [], inExp: [], needDate: [], recvNoDate: [] };
  for (const o of list) {
    if (o.noDate) (o.kind === 'in' ? r.recvNoDate : r.needDate).push(o);
    else if (o.kind === 'in') (o.conf === 'confirmed' ? r.inConf : r.inExp).push(o);
    else (o.pay === 'direct' ? r.direct : r.auto).push(o);
  }
  // 세금계산서는 있는데 계획에 안 넣은 미지급·미수 → 날짜를 정해야 하는 건
  const planned = new Set(live('plans').map(p => p.invoiceId).filter(Boolean));
  for (const i of M.inv.list) {
    const s = M.inv.st[i.id];
    if (!s.remain || planned.has(i.id)) continue;
    const o = { key: 'inv:' + i.id, src: 'inv', invoiceId: i.id, date: '', wdate: i.wdate, kind: i.kind === 'sales' ? 'in' : 'out', amount: s.eff, remain: s.remain, paid: s.paid, partial: s.state === 'partial' ? 'invoice' : '', title: i.name + (i.note ? ' · ' + i.note : ''), noDate: true, done: false };
    (o.kind === 'in' ? r.recvNoDate : r.needDate).push(o);
  }
  // 외상으로 산 비용 (계산서 없이 핸드폰에서 "아직 안 냄"으로 적은 것) → 지급일 확인 필요
  for (const c of live('costs')) {
    if (c.pay !== 'unpaid' || c.invoiceId || (!S.settings.includePersonal && c.personal)) continue;
    r.needDate.push({ key: 'cost:' + c.id, src: 'cost', costId: c.id, date: '', wdate: c.date, kind: 'out', amount: c.total, title: `${c.vendor || c.note || '외상 비용'} (외상)`, noDate: true, done: false });
  }
  r.recvNoDate.sort((a, b) => ((a.wdate || '') < (b.wdate || '') ? -1 : 1));
  r.needDate.sort((a, b) => ((a.wdate || '') < (b.wdate || '') ? -1 : 1));
  const open = a => a.filter(o => !o.done).reduce((s, o) => s + left(o), 0);
  r.directSum = open(r.direct); r.autoSum = open(r.auto); r.confSum = open(r.inConf); r.expSum = open(r.inExp);
  r.start = M.totalEst;
  r.avail = r.start - r.directSum - r.autoSum + r.confSum; // 확정 가용자금 (예상 수금 제외)
  return r;
}

export function projection(S, M, days) {
  const from = todayStr(), to = addDays(from, days);
  const evs = occurrences(S, M, from, to).filter(o => !o.done && !o.noDate && (S.settings.includePersonal || !o.personal));
  let bal = M.totalEst, inSum = 0, outSum = 0, expIn = 0;
  const pts = [{ date: from, bal }];
  let min = { bal, date: from };
  for (const e of evs) {
    const d = e.date < from ? from : e.date;
    e.at = d;
    const a = left(e);
    if (e.kind === 'in' && e.conf !== 'confirmed') { expIn += a; e.after = bal; continue; } // 예상 수금은 잔액 예측에 넣지 않음
    if (e.kind === 'in') { bal += a; inSum += a; } else { bal -= a; outSum += a; }
    e.after = bal;
    pts.push({ date: d, bal });
    if (bal < min.bal) min = { bal, date: d };
  }
  return { from, to, days, start: M.totalEst, evs, pts, min, end: bal, inSum, outSum, expIn };
}

export function planHint(M, o) {
  return o.done ? null : (o.hint || null);
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
    // 은행 거래 방법에 자동이체 표시가 있으면 자동이체로 추천 (사용자가 바꿀 수 있음)
    const pay = list.some(t => /자동|CMS|지로|펌|오픈뱅킹출금/i.test(t.method || '')) ? 'auto' : 'direct';
    res.push({ title, bankName: title, pay, amount: last.out, day: days[Math.floor(days.length / 2)], acct: last.acct, months: months.size });
  }
  return res.sort((a, b) => b.amount - a.amount);
}

// ───────── 거래처 ─────────
export function partners(M) {
  const p = new Map();
  for (const i of M.inv.list) {
    const s = M.inv.st[i.id];
    const r = p.get(i.biz) || { biz: i.biz, name: i.name, sales: 0, purchase: 0, recv: 0, pay: 0, paid: 0, n: 0, last: '' };
    if (i.kind === 'sales') r.sales += i.total; else { r.purchase += i.total; r.paid += s.paid || 0; }
    if (s.remain) { if (i.kind === 'sales') r.recv += s.remain; else r.pay += s.remain; }
    r.n++;
    if (i.wdate > r.last) { r.last = i.wdate; r.name = i.name; }
    p.set(i.biz, r);
  }
  return [...p.values()].sort((a, b) => (b.sales + b.purchase) - (a.sales + a.purchase));
}
