// 작업별 원가: 거래처 → 현장 → 작업건, 비용(원가) 장부, 배분, 검색
// - 원가는 costs 한 곳에만 기록합니다. 같은 돈(통장 거래·세금계산서·핸드폰 기록)이 두 번 원가로 잡히지 않게 막습니다.
// - 나중에 업무관리·재고 앱과 연결할 수 있도록 거래처 ID(pt_), 현장 ID(st_), 작업건 ID(jb_)와 PO 번호·라인을 둡니다.
// - 금액은 모두 원 단위 정수. 나눌 때는 나머지까지 정확히 배분해서 합계가 1원도 틀리지 않게 합니다.
import { store, live, put } from './store.js';
import { normName, hash, uid, dayDiff } from './util.js';

export const CAT = { material: '자재', labor: '인건비', expense: '경비', outsource: '외주비' };
export const EVK = { receipt: '영수증', transfer: '이체 캡처', other: '기타' };

// ───── 거래처 · 현장 · 작업건 ─────
// 같은 이름(또는 사업자번호)이면 어느 기기에서 만들어도 같은 ID → 두 기기에서 따로 만들어도 하나로 합쳐짐
export const partyIdOf = (name, biz) => (biz && String(biz).replace(/\D/g, '') ? 'pt_' + String(biz).replace(/\D/g, '') : 'pt_' + hash(normName(name)));
export const siteIdOf = (partyId, name) => 'st_' + hash(partyId + '|' + normName(name));
export const jobIdOf = (siteId, name, po) => 'jb_' + hash(siteId + '|' + normName(name) + '|' + normName(po || ''));

export function partyList(M) {
  const map = new Map();
  for (const p of live('parties')) map.set(p.id, { id: p.id, name: p.name, biz: p.biz || '' });
  if (M) for (const i of M.inv.list) { const id = partyIdOf(i.name, i.biz); if (!map.has(id)) map.set(id, { id, name: i.name, biz: i.biz, fromInv: true }); }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
export function ensureParty(M, id) {
  const S = store.state;
  if (S.parties[id] && !S.parties[id].deleted) return S.parties[id];
  const p = partyList(M).find(x => x.id === id);
  return p ? put('parties', { id, name: p.name, biz: p.biz || '' }) : null;
}
export function newParty(name, biz = '') {
  const id = partyIdOf(name, biz);
  const ex = store.state.parties[id];
  return ex && !ex.deleted ? ex : put('parties', { id, name: name.trim(), biz });
}
export const siteList = partyId => live('sites').filter(s => s.partyId === partyId).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
export function newSite(partyId, name) {
  const id = siteIdOf(partyId, name);
  const ex = store.state.sites[id];
  return ex && !ex.deleted ? ex : put('sites', { id, partyId, name: name.trim() });
}
export const jobList = siteId => live('jobs').filter(j => j.siteId === siteId).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
export function newJob(partyId, siteId, name, po = '', poLine = '') {
  const id = jobIdOf(siteId, name, po);
  const ex = store.state.jobs[id];
  // ext: 나중에 업무관리(견적·PO·납품·GR)·재고 앱의 ID를 적을 자리 (지금은 비어 있음, 연동 꺼짐)
  return ex && !ex.deleted ? ex : put('jobs', { id, partyId, siteId, name: name.trim(), po: po.trim(), poLine: String(poLine || '').trim(), status: 'open', ext: {} });
}
export function jobLabel(j) {
  const S = store.state;
  const p = S.parties[j.partyId], s = S.sites[j.siteId];
  return [p && !p.deleted ? p.name : '', s && !s.deleted ? s.name : '', j.name].filter(Boolean).join(' → ') + (j.po ? ` (PO ${j.po}${j.poLine ? '-' + j.poLine : ''})` : '');
}

// ───── 금액 나누기 ─────
// total을 weights 비율로 정수 배분 (가장 큰 나머지 방식) → 합이 정확히 total
export function splitInt(total, weights) {
  const W = weights.reduce((s, w) => s + w, 0);
  if (!W) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / W);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, k) => [r - Math.floor(r), k]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]]++;
  return out;
}

// 원가 기준 금액: 공급가를 알면 공급가, 모르면 합계 (부가세 구분 안 됨으로 표시)
export const costBase = c => (c.supply != null && c.supply !== '' ? Number(c.supply) : Number(c.total));

// 실제로 낸 돈(합계 기준)
export function paidOf(M, c) {
  if (c.invoiceId && M.inv.st[c.invoiceId]) {
    const s = M.inv.st[c.invoiceId];
    if (s.state === 'paid' || s.state === 'receipt' || s.state === 'na') return c.total;
    return Math.min(c.total, s.paid || 0);
  }
  return c.pay === 'paid' ? c.total : 0;
}

// 통장 대조 상태
export function reconOf(M, c) {
  if (c.txnId && M.txById.get(c.txnId)) return { k: 'bank', label: '대조 완료' };
  if (c.manualId) { const m = store.state.manual[c.manualId]; if (m && !m.deleted && m.linkTxn) return { k: 'bank', label: '대조 완료' }; }
  if (c.invoiceId) { const s = M.inv.st[c.invoiceId]; if (s) return s.state === 'paid' || s.state === 'receipt' ? { k: 'inv', label: '계산서 대조 완료' } : s.state === 'partial' ? { k: 'part', label: `일부 지급 ${s.paid.toLocaleString('ko-KR')}` } : { k: 'unpaid', label: '미지급 (계산서)' }; }
  if (c.pay !== 'paid') return { k: 'unpaid', label: '미지급' };
  return { k: 'user', label: '사용자 확인 · 은행 대조 전' };
}

// 이 비용이 가리키는 실제 돈 (같은 돈을 두 번 원가로 잡지 않게 비교할 때 씀)
function moneyKeys(M, c) {
  const k = [];
  if (c.txnId) k.push('t:' + c.txnId);
  if (c.manualId) { const m = store.state.manual[c.manualId]; if (m && !m.deleted && m.linkTxn) k.push('t:' + m.linkTxn); k.push('m:' + c.manualId); }
  if (c.invoiceId) { k.push('i:' + c.invoiceId); for (const t of M.inv.st[c.invoiceId]?.txns || []) k.push('t:' + t); }
  return k;
}
// 이미 원가로 잡힌 돈인지: 통장 거래 id / 계산서 id / 핸드폰 기록 id
export function costUsing(M, { txnId, invoiceId, manualId }) {
  const want = new Set();
  if (txnId) { want.add('t:' + txnId); for (const i of M.inv.txInv.get(txnId) || []) want.add('i:' + i); }
  if (invoiceId) { want.add('i:' + invoiceId); for (const t of M.inv.st[invoiceId]?.txns || []) want.add('t:' + t); }
  if (manualId) want.add('m:' + manualId);
  return live('costs').find(c => moneyKeys(M, c).some(k => want.has(k))) || null;
}
// 같은 돈을 가리키는 비용이 둘 이상인 경우 (예: 핸드폰 기록이 나중에 통장 거래와 합쳐졌는데, 그 통장 거래도 따로 원가 등록)
export function dupCosts(M) {
  const seen = new Map(), out = [];
  for (const c of live('costs').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const k of moneyKeys(M, c)) {
      if (seen.has(k) && seen.get(k).id !== c.id) { out.push([seen.get(k), c]); break; }
      seen.set(k, c);
    }
  }
  return out;
}
// 금액·날짜가 비슷한 기존 비용 (영수증과 이체 캡처를 따로 올려 같은 비용이 두 번 생기는 것 방지)
export function similarCosts(total, date) {
  return live('costs').filter(c => c.total === total && Math.abs(dayDiff(c.date, date)) <= 3);
}

// ───── 작업별 집계 ─────
// opts.from/to: 기간 (비용 날짜 기준)
export function costModel(M, opts = {}) {
  const inPer = c => (!opts.from || c.date >= opts.from) && (!opts.to || c.date <= opts.to);
  const jobs = live('jobs');
  const z = () => ({ material: 0, labor: 0, expense: 0, outsource: 0 });
  const byJob = new Map(jobs.map(j => [j.id, { job: j, cat: z(), base: 0, vat: 0, total: 0, paid: 0, unpaid: 0, noVat: 0, items: [], lines: [] }]));
  const unalloc = [];
  const costs = live('costs').filter(inPer);
  for (const c of costs) {
    const base = costBase(c);
    const al = (c.alloc || []).filter(a => a.amount > 0 && byJob.has(a.jobId));
    const allocSum = al.reduce((s, a) => s + a.amount, 0);
    if (allocSum < base) unalloc.push({ c, left: base - allocSum });
    if (!al.length) continue;
    // 합계(실제 돈)·부가세·낸 돈을 배분 비율대로 정수 배분. 미배분 몫도 한 칸으로 넣어서 합이 정확히 맞게.
    const w = al.map(a => a.amount).concat(base > allocSum ? [base - allocSum] : []);
    const tot = splitInt(c.total, w), vat = splitInt(Number(c.vat || 0), w), paid = splitInt(paidOf(M, c), w);
    al.forEach((a, k) => {
      const r = byJob.get(a.jobId);
      r.cat[c.cat || 'expense'] += a.amount; r.base += a.amount; r.total += tot[k]; r.vat += vat[k]; r.paid += paid[k]; r.unpaid += tot[k] - paid[k];
      if (c.supply == null || c.supply === '') r.noVat += a.amount;
      r.lines.push({ c, amount: a.amount, total: tot[k], paid: paid[k] });
    });
    // 품목(수량): 품목에 작업이 정해져 있으면 그 작업, 아니면 작업이 하나뿐인 비용이면 그 작업
    for (const it of c.items || []) {
      const jid = it.jobId || (al.length === 1 ? al[0].jobId : '');
      if (jid && byJob.has(jid)) byJob.get(jid).items.push({ ...it, c });
    }
  }
  return { byJob, unalloc, costs };
}

// 품목별 합계 (같은 품명·단위끼리 수량·금액 합산)
export function itemSummary(items) {
  const g = new Map();
  for (const it of items) {
    const k = normName(it.name) + '|' + (it.unit || '');
    const r = g.get(k) || { name: it.name, unit: it.unit || '', qty: 0, amount: 0, n: 0 };
    r.qty = Math.round((r.qty + Number(it.qty || 0)) * 1000) / 1000; r.amount += Number(it.amount || 0); r.n++;
    g.set(k, r);
  }
  return [...g.values()].sort((a, b) => b.amount - a.amount);
}

// 검색: 거래처·현장·작업명·PO·비고·지급처·품명. 띄어쓴 단어가 모두 들어 있어야 함 (예: "목동 진동센서")
export function searchJobs(M, CM, q) {
  const toks = String(q || '').split(/\s+/).map(normName).filter(Boolean);
  const S = store.state;
  const costText = c => normName([c.note, c.vendor, ...(c.items || []).map(i => i.name)].join(' '));
  const res = [];
  for (const r of CM.byJob.values()) {
    const j = r.job;
    const head = normName([S.parties[j.partyId]?.name, S.sites[j.siteId]?.name, j.name, j.po, j.poLine, j.note].join(' '));
    const all = head + ' ' + r.lines.map(l => costText(l.c)).join(' ');
    if (!toks.length || toks.every(t => all.includes(t))) res.push(r);
  }
  const loose = toks.length ? CM.unalloc.filter(u => toks.every(t => costText(u.c).includes(t))) : [];
  return { jobs: res, loose };
}

export function newCostId() { return uid('c'); }
