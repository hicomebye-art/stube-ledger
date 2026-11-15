// 화면 그리기와 버튼 동작
import { store, put, patch, remove, setSettings, live, commit, merge, replaceState, emptyState } from './store.js';
import { model, projection, occurrences, dayPlan, lastCovered, PAY, left, vatPeriods, cardUsage, cardMerchants, recurringSuggestions, partners, planHint, REVIEW_TYPES } from './engine.js';
import { esc, won, todayStr, addDays, dayDiff, uid, nowTs, parseWonInput, ymOf, addMonths, daysInMonth, fmtMD, fmtYM, normName } from './util.js';
import { parseFile } from './parsers.js';
import { commitImport, previewCounts, BANK_TO_ACCT } from './importer.js';
import * as drive from './drive.js';
import { SANDBOX, NS, BUILD } from './env.js';
import { extendUI, costAddView, jobsView } from './jobs-ui.js';
import { costModel, dupCosts, costUsing } from './jobs.js';

// 카카오톡·네이버 앱 안의 브라우저에서는 구글 로그인이 막힙니다 → 크롬으로 열도록 안내
const UA = navigator.userAgent || '';
const IN_APP = /KAKAOTALK|NAVER\(inapp|DaumApps|Instagram|FBAN|FBAV|Line\/|everytimeApp|; wv\)/i.test(UA);
function externalHref() {
  const u = location.href;
  if (/KAKAOTALK/i.test(UA)) return 'kakaotalk://web/openExternal?url=' + encodeURIComponent(u);
  if (/Android/i.test(UA)) return `intent://${u.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
  return u;
}
const inAppBar = () => (IN_APP ? `<div class="sandbox">카카오톡·네이버 같은 앱 안에서 열린 화면이라 구글 로그인이 막힙니다. <a href="${esc(externalHref())}">크롬으로 열기</a></div>` : '');

// 핸드폰: 드라이브에 아직 안 올라간 상태를 크게 알려줌
export function syncBar() {
  const s = drive.sync.status;
  const pend = store.dirty ? ' 이 기기에서 적은 기록이 아직 드라이브에 올라가지 않았습니다 (PC에서 안 보임).' : '';
  if (s === 'off') return `<div class="syncbar bad">구글 드라이브에 연결되지 않았습니다.${pend} <button class="sm primary" data-act="connect">연결</button></div>`;
  if (s === 'needLogin') return `<div class="syncbar bad">구글 연결이 풀렸습니다.${pend} <button class="sm primary" data-act="connect">다시 연결</button></div>`;
  if (s === 'error') return `<div class="syncbar bad">저장 오류: ${esc(drive.sync.msg === 'API_OFF' ? 'Drive API 꺼짐' : drive.sync.msg)}${pend} <button class="sm" data-act="sync">다시 시도</button></div>`;
  if (s === 'offline') return `<div class="syncbar warn">인터넷이 끊겼습니다. 연결되면 자동으로 올라갑니다.</div>`;
  if (s === 'ok' && drive.sync.lastAt) return `<div class="syncbar ok">드라이브와 맞춤 ${new Date(drive.sync.lastAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>`;
  return '';
}

const sandboxBar = () => (SANDBOX ? `<div class="sandbox">테스트 장부 "${esc(SANDBOX)}" 입니다 — 실제 장부가 아닙니다. 드라이브의 별도 폴더에 저장됩니다. <a href="./">실제 장부로 가기</a></div>` : '');

const S = () => store.state;
const $ = sel => document.querySelector(sel);
const isMobileWidth = () => window.matchMedia('(max-width: 767px)').matches;

const ui = {
  ledger: { acct: '', month: '', kind: '', personal: false, q: '', limit: 300 },
  inv: { kind: 'sales', period: '', status: '' },
  plan: { days: 30 },
  home: { range: 'today' },
  cards: { sel: null },
  partners: { q: '' },
  review: { showDismissed: false },
  imports: [],
  add: { amount: '', acct: '', memo: '', date: '', personal: false },
  occ: new Map(),
};

const NAV = [
  ['home', '홈'], ['import', '자료 넣기'], ['ledger', '통합 장부'], ['review', '검토'], ['plan', '자금 계획'], ['jobs', '작업·원가'],
  ['invoices', '세금계산서'], ['cards', '카드 사용'], ['recurring', '고정 지출'], ['partners', '거래처'], ['settings', '설정'],
];

// ───────── 공통 ─────────
let toastTimer;
export function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

const acctLabel = a => (a.holder ? `${a.name} · ${a.holder}` : a.name);
const acctName = (M, id) => (M.acctById[id] ? M.acctById[id].name : (id || '-'));
const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;
const amt = (n, cls = '') => (n ? `<span class="num ${cls}">${won(n)}</span>` : '');
const tsLabel = t => `${fmtMD(t.date)}${t.time ? ' ' + t.time.slice(0, 5) : ''}`;

function acctOptions(M, sel, blank) {
  return (blank ? `<option value="">${esc(blank)}</option>` : '') + M.accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(acctLabel(a))}</option>`).join('');
}

function txLine(M, t) {
  return `<div class="txline"><span class="d">${tsLabel(t)}</span><span class="a">${esc(acctName(M, t.acct))}</span><span class="t">${esc(t.desc)}</span>${t.in ? `<span class="num in">+${won(t.in)}</span>` : ''}${t.out ? `<span class="num out">-${won(t.out)}</span>` : ''}</div>`;
}

export function syncBadge() {
  const s = drive.sync;
  if (s.status === 'ok') return `<span class="sync-ok">드라이브 저장됨</span>`;
  if (s.status === 'syncing') return `<span class="sync-mid">저장 중…</span>`;
  if (s.status === 'offline') return `<span class="sync-warn">오프라인 · 연결되면 저장</span>`;
  if (s.status === 'error') {
    const why = s.msg === 'API_OFF'
      ? `구글 클라우드에서 Drive API가 꺼져 있음 → <a href="${drive.API_ON_URL}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">켜러 가기</a>`
      : esc(s.msg.length > 60 ? s.msg.slice(0, 60) + '…' : s.msg);
    return `<span class="sync-err" title="${esc(s.msg)}">저장 오류: ${why}</span> <button class="sm" data-act="sync">다시 시도</button>`;
  }
  if (s.status === 'needLogin') return `<button class="sm primary" data-act="connect">드라이브 다시 연결</button>`;
  return `<button class="sm primary" data-act="connect">구글 드라이브 연결</button>`;
}

export function renderSync() {
  for (const id of ['sync', 'msync']) { const el = document.getElementById(id); if (el) el.innerHTML = syncBadge(); }
  const bar = document.getElementById('syncbar');
  if (bar) bar.innerHTML = syncBar();
}

// ───────── 렌더 ─────────
export function render() {
  const ae = document.activeElement;
  const fid = ae && ae.id;
  let sel = null;
  try { sel = fid && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null; } catch { sel = null; }
  const route = (location.hash || '').slice(1) || (isMobileWidth() ? 'm' : 'home');
  const M = model();
  const app = document.getElementById('app');
  if (route === 'm' || route === 'm-add') app.innerHTML = inAppBar() + sandboxBar() + `<div id="syncbar">${syncBar()}</div>` + mobile(route, M);
  else app.innerHTML = inAppBar() + sandboxBar() + shell(route, M);
  if (fid) {
    const el = document.getElementById(fid);
    if (el) { el.focus(); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* 무시 */ } } }
  }
}

function shell(route, M) {
  const open = M.review.filter(x => !x.dismissed).length;
  const view = VIEWS[route] || VIEWS.home;
  return `
  <header class="top">
    <div class="brand">S-TUBE</div>
    <nav class="toptabs"><a href="#work" class="${route === 'work' ? 'on' : ''}">업무관리</a><a href="#home" class="${route !== 'work' ? 'on' : ''}">경리</a></nav>
    <div class="sync" id="sync">${syncBadge()}</div>
  </header>
  <div class="layout">
    <aside class="side">
      ${NAV.map(([id, label]) => `<a href="#${id}" class="${route === id ? 'on' : ''}">${label}${id === 'review' && open ? ` <span class="badge">${open}</span>` : ''}</a>`).join('')}
      <a href="#m" class="sub">핸드폰 화면</a>
      <div class="muted s" style="padding:8px 12px">앱 버전 ${BUILD}</div>
    </aside>
    <main id="main">${view(M)}</main>
  </div>`;
}

const VIEWS = {};

// ───────── 오늘 할 일 ─────────
const RANGES = [['today', '오늘'], ['tomorrow', '내일'], ['week', '이번 주'], ['d16', '16일'], ['eom', '말일']];
function rangeOf(k) {
  const t = todayStr();
  const ym = ymOf(t);
  if (k === 'tomorrow') { const d = addDays(t, 1); return { from: d, to: d, noOverdue: true, label: `내일 ${fmtMD(d)}` }; }
  if (k === 'week') { const dow = new Date(t + 'T00:00:00').getDay(); const e = addDays(t, (7 - dow) % 7); return { from: t, to: e, label: `이번 주 (${fmtMD(t)}~${fmtMD(e)})` }; }
  if (k === 'd16') { const m = Number(t.slice(8)) > 16 ? addMonths(ym, 1) : ym; const e = `${m}-16`; return { from: t, to: e, label: `16일 지급일까지 (${fmtMD(t)}~${fmtMD(e)})` }; }
  if (k === 'eom') { const e = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`; return { from: t, to: e, label: `말일까지 (${fmtMD(t)}~${fmtMD(e)})` }; }
  return { from: t, to: t, label: `오늘 ${fmtMD(t)} (지난 미완료 포함)` };
}

function statusTag(o) {
  if (o.done) {
    if (o.doneBy === 'bank') return tag(`대조 완료 ${fmtMD(o.tx.date)}${o.diff ? ` · 실제 ${won(o.actual)} (차이 ${o.diff > 0 ? '+' : ''}${won(o.diff)})` : ''}`, o.diff ? 'amber' : 'green');
    if (o.doneBy === 'invoice') return tag('계산서와 대조 완료', 'green');
    return tag('사용자 확인 · 은행 대조 전', 'blue');
  }
  if (o.partial) {
    const src = { bank: '은행 확인', invoice: '계산서 연결', user: '사용자 입력 · 은행 대조 전' }[o.partial] || '';
    return tag(`일부 ${o.kind === 'in' ? '수금' : '지급'} ${won(o.paid)} · 잔액 ${won(o.remain)}${src ? ' (' + src + ')' : ''}`, 'amber') + (o.noDate ? tag(o.kind === 'in' ? '수금일 확인 필요' : '지급일 확인 필요', 'amber') : '');
  }
  if (o.noDate) return tag(o.kind === 'in' ? '수금일 확인 필요' : '지급일 확인 필요', 'amber');
  if (o.chk === 'missing') return tag(o.kind === 'in' ? '날짜 지났는데 입금 없음' : o.pay === 'direct' ? '연체 · 통장에 없음' : '예정일 지났는데 통장에 없음', 'red');
  if (o.chk === 'unverified') return tag('미확인 · 그 기간 은행 자료 없음', 'gray');
  if (o.chk === 'seen') return tag(`통장 ${fmtMD(o.hint.date)}에 같은 금액 있음 → 맞으면 체크`, 'amber');
  return '';
}

function occTags(o) {
  return [o.src === 'rec' || o.recId ? tag('고정') : '', o.pay && o.pay !== 'direct' ? tag(PAY[o.pay], 'blue') : '', o.personal ? tag('개인', 'amber') : '', o.src === 'vat' ? tag('세금', 'blue') : ''].join('');
}

function dpRow(M, o, compact) {
  const canCheck = o.src !== 'vat' && o.src !== 'inv' && o.src !== 'cost';
  if (canCheck) ui.occ.set(o.key, o);
  const ck = canCheck ? `<input type="checkbox" data-chg="occDone" data-key="${esc(o.key)}" ${o.done ? 'checked' : ''} ${o.doneBy === 'bank' || o.doneBy === 'invoice' ? 'disabled' : ''} aria-label="${o.kind === 'in' ? '입금 확인' : '완료'}">` : '<span class="ckph"></span>';
  const when = o.noDate ? (o.wdate ? `계산서 ${fmtMD(o.wdate)}` : '날짜 없음') : fmtMD(o.date);
  const st = statusTag(o);
  const a = o.done ? o.amount : left(o);
  if (compact) return `<label class="mrow ${o.done ? 'done' : ''}">${ck}<span class="d">${when}</span><span class="t">${esc(o.title)} ${occTags(o)}${st ? `<br>${st}` : ''}</span><span class="num ${o.kind}">${o.kind === 'in' ? '+' : '-'}${won(a)}</span></label>`;
  return `<tr class="${o.done ? 'done' : ''}"><td class="ck">${ck}</td><td class="nowrap">${when}</td><td>${esc(o.title)} ${occTags(o)} ${st}</td><td>${o.acct ? esc(acctName(M, o.acct)) : '<span class="muted">-</span>'}</td><td class="r">${amt(a, o.kind)}${o.partial ? `<div class="muted s">전체 ${won(o.amount)}</div>` : ''}</td></tr>`;
}

function dpBlock(M, title, list, sum, opts = {}) {
  const { compact, empty = '없음', note = '', limit = 50 } = opts;
  const head = `<div class="row-h"><h2>${title}</h2>${sum !== null ? `<b class="${opts.cls || ''}">${won(sum)}원</b>` : ''}</div>${note ? `<div class="hint">${note}</div>` : ''}`;
  if (!list.length) return `<section class="${compact ? 'mcard' : 'card'}">${head}<div class="muted">${empty}</div></section>`;
  const rows = list.slice(0, limit).map(o => dpRow(M, o, compact)).join('');
  const more = list.length > limit ? `<div class="muted">외 ${list.length - limit}건 → <a href="#plan">자금 계획</a></div>` : '';
  return `<section class="${compact ? 'mcard' : 'card'}">${head}${compact ? rows : `<table class="tbl"><thead><tr><th class="ck"></th><th>날짜</th><th>내용</th><th>통장</th><th class="r">금액</th></tr></thead><tbody>${rows}</tbody></table>`}${more}</section>`;
}

// 확인할 돈: 연체, 자동출금 미확인, 금액 차이, 은행 미대조, 미수·미지급, 은행 자료 없는 기간
function checkItems(M) {
  const s = S(), T = todayStr();
  const past = occurrences(s, M, T, T).filter(o => o.overdue && !o.done && (s.settings.includePersonal || !o.personal));
  const month = occurrences(s, M, `${ymOf(T)}-01`, T).filter(o => o.doneBy === 'bank' && o.diff);
  const open = M.review.filter(x => !x.dismissed);
  const n = t => open.filter(x => x.type === t).length;
  const items = [
    ['연체 (보낼 날 지났는데 통장에 없음)', past.filter(o => o.kind === 'out' && o.pay === 'direct' && o.chk === 'missing').length, '#plan'],
    ['자동출금 예정일 지났는데 통장에 없음', past.filter(o => o.kind === 'out' && o.pay !== 'direct' && o.chk === 'missing').length, '#plan'],
    ['입금 예정일 지났는데 입금 없음', past.filter(o => o.kind === 'in' && o.chk === 'missing').length, '#plan'],
    ['통장에 같은 금액이 있어 확인만 하면 되는 건', past.filter(o => o.chk === 'seen').length, '#plan'],
    ['미확인 (그 기간 은행 자료를 아직 안 넣음)', past.filter(o => o.chk === 'unverified').length, '#import'],
    ['이번 달 예상액과 실제 출금 금액 차이', month.length, '#plan'],
    ['핸드폰 기록 중 은행과 아직 대조 안 된 것', M.manual.filter(m => !m.linkTxn).length, '#review'],
    ['미수금 (매출 계산서 입금 안 보임)', n('unpaidSales'), '#review'],
    ['미지급 (매입 계산서 송금 안 보임)', n('unpaidPurchase'), '#review'],
    ['잔액이 이어지지 않는 곳', n('balance'), '#review'],
    ['미분류 증빙·비용 (작업 안 정함)', costModel(M).unalloc.length, '#jobs'],
    ['같은 돈이 원가에 두 번 잡힘', dupCosts(M).length, '#jobs'],
    ['내 통장 이체인지 확인할 것', n('xfer'), '#review'],
  ].filter(x => x[1]);
  const cov = M.accounts.map(a => { const e = lastCovered(M, a.id); return `${esc(a.name)} ${e ? fmtMD(e) + '까지' : '자료 없음'}`; }).join(' · ');
  return { items, cov };
}

function todayPanel(M, compact) {
  const R = rangeOf(ui.home.range);
  const d = dayPlan(S(), M, R.from, R.to, { noOverdue: R.noOverdue });
  const ck = checkItems(M);
  const chips = `<div class="filters chips">${RANGES.map(([k, l]) => `<button class="${k === ui.home.range ? 'primary' : ''}" data-act="range" data-k="${k}">${l}</button>`).join('')}<span class="muted">${esc(R.label)}</span></div>`;
  const C = compact;
  const summary = C
    ? `<section class="mcard"><div class="kv"><span>지금 잔액 (추정)</span><b>${won(d.start)}</b></div><div class="kv"><span>직접 보낼 돈</span><b class="out">-${won(d.directSum)}</b></div><div class="kv"><span>자동으로 나갈 돈</span><b class="out">-${won(d.autoSum)}</b></div><div class="kv"><span>확정 받을 돈</span><b class="in">+${won(d.confSum)}</b></div><div class="kv big2"><span>확정 가용자금</span><b class="${d.avail < 0 ? 'red' : ''}">${won(d.avail)}</b></div>${d.expSum ? `<div class="muted">예상 수금 ${won(d.expSum)}원은 가용자금에 넣지 않았습니다</div>` : ''}</section>`
    : `<div class="grid5">
      <div class="mc"><div class="l">지금 잔액 (추정)</div><div class="v">${won(d.start)}</div></div>
      <div class="mc"><div class="l">직접 보낼 돈</div><div class="v out">${won(d.directSum)}</div></div>
      <div class="mc"><div class="l">자동으로 나갈 돈</div><div class="v out">${won(d.autoSum)}</div><div class="s">직접 보낼 돈에서 뺐음</div></div>
      <div class="mc"><div class="l">확정 받을 돈</div><div class="v in">${won(d.confSum)}</div>${d.expSum ? `<div class="s">예상 수금 ${won(d.expSum)} 별도</div>` : ''}</div>
      <div class="mc ${d.avail < 0 ? 'bad' : ''}"><div class="l">확정 가용자금</div><div class="v">${won(d.avail)}</div><div class="s">예상 수금 제외</div></div>
    </div>`;
  const checks = `<section class="${C ? 'mcard' : 'card'}"><div class="row-h"><h2>확인할 돈</h2></div>
    ${ck.items.length ? ck.items.map(([l, n, href]) => `<div class="kv"><a href="${href}">${l}</a><b class="red">${n}건</b></div>`).join('') : '<div class="muted">확인할 것이 없습니다.</div>'}
    <div class="hint">은행 자료 기간: ${ck.cov}. 자료가 없는 기간의 돈은 미지급으로 보지 않고 "미확인"으로 둡니다.</div></section>`;
  return `${chips}${summary}
    ${dpBlock(M, '직접 보낼 돈', d.direct, d.directSum, { compact: C, cls: 'out', empty: '이 기간에 직접 보낼 돈이 없습니다.' })}
    ${dpBlock(M, '자동으로 나갈 돈', d.auto, d.autoSum, { compact: C, cls: 'out', empty: '자동이체·카드 결제 예정이 없습니다.', note: '자동이체·카드 결제는 통장에 찍히면 저절로 "대조 완료"가 됩니다. 직접 보낼 합계에는 들어가지 않습니다.' })}
    ${dpBlock(M, '받을 돈 · 확정', d.inConf, d.confSum, { compact: C, cls: 'in', empty: '확정된 입금 예정이 없습니다.', note: '입금되면 체크하세요 (은행 자료가 들어오면 대조 완료로 바뀝니다).' })}
    ${d.inExp.length ? dpBlock(M, '받을 돈 · 예상 (가용자금 미포함)', d.inExp, d.expSum, { compact: C, cls: 'muted' }) : ''}
    ${checks}
    ${d.needDate.length ? dpBlock(M, '지급일 확인 필요', d.needDate, null, { compact: C, limit: C ? 5 : 10, note: '지급일이 정해지지 않은 보낼 돈입니다. 합계에는 넣지 않았습니다. <a href="#plan">자금 계획</a>에서 날짜를 정하세요.' }) : ''}
    ${d.recvNoDate.length ? dpBlock(M, '수금일 확인 필요', d.recvNoDate, null, { compact: C, limit: C ? 5 : 10, note: '계산서는 발행했는데 받을 날짜가 정해지지 않은 돈입니다. <a href="#plan">자금 계획</a>에서 날짜를 정하세요.' }) : ''}`;
}

// ───────── 홈 ─────────
VIEWS.home = M => {
  const s = S();
  const p = projection(s, M, 30);
  const open = M.review.filter(x => !x.dismissed);
  const today = todayStr();
  const accs = M.accounts.map(a => {
    const b = M.balances[a.id];
    return `<div class="mc"><div class="l">${esc(acctLabel(a))}</div><div class="v">${b.bal === null ? '<span class="muted">자료 없음</span>' : won(b.est)}</div><div class="s">${b.lastDate ? '은행 기준 ' + fmtMD(b.lastDate) : ''}${b.pending ? ` · 핸드폰 기록 -${won(b.pending)}` : ''}</div></div>`;
  }).join('');
  const check = !M.txns.length
    ? `<div class="note">아직 자료가 없습니다. <a href="#import">자료 넣기</a>에서 은행·홈택스 엑셀을 넣어주세요.</div>`
    : M.breaks.length === 0
      ? `<div class="okline">✓ 은행 잔액과 장부 잔액이 모두 맞습니다 (오차 0원)</div>`
      : `<div class="errline">잔액이 이어지지 않는 곳 ${M.breaks.length}건 → <a href="#review">검토</a></div>`;
  const byType = t => open.filter(x => x.type === t).length;
  const rv = [
    ['중복 의심', byType('dup')], ['이중 송금 의심', byType('dbl')], ['묶음 입금·송금 확인', byType('group')], ['미수금', byType('unpaidSales')], ['미지급', byType('unpaidPurchase')],
    ['핸드폰 기록 확인', byType('mlink') + byType('morph')], ['계산서 없는 입금', byType('noinv')], ['잔액 불일치', byType('balance')],
  ].filter(x => x[1]);
  ui.occ.clear();
  const nextDue = nextImportDue();
  const minBal = s.settings.minBalance || 0;
  const warn = minBal && p.min.bal < minBal ? `<div class="errline">${fmtMD(p.min.date)}에 잔액이 최소 유지금액보다 ${won(minBal - p.min.bal)}원 부족할 것으로 예상됩니다.</div>` : '';
  return `
  <h1>오늘 할 일</h1>
  ${todayPanel(M, false)}
  <h2 class="sect">통장 잔액</h2>
  <div class="grid5">${accs}<div class="mc total"><div class="l">합계</div><div class="v">${won(M.totalEst)}</div><div class="s">핸드폰 기록 반영</div></div></div>
  ${check}
  <div class="two">
    <section class="card">
      <div class="row-h"><h2>자금 계획 (30일)</h2><a href="#plan" class="more">자세히</a></div>
      ${chartSvg(p, minBal)}
      ${warn}
      <div class="mini">30일 뒤 예상 잔액 <b>${won(p.end)}</b> · 확정 입금 ${won(p.inSum)} · 출금 ${won(p.outSum)}${p.expIn ? ` · 예상 수금 ${won(p.expIn)} (그래프에 미포함)` : ''}</div>
    </section>
    <section class="card">
      <div class="row-h"><h2>검토할 일</h2><a href="#review" class="more">전체</a></div>
      ${rv.length ? rv.map(([l, n]) => `<div class="kv"><span>${l}</span><b class="${n ? 'red' : ''}">${n}건</b></div>`).join('') : '<div class="muted">검토할 항목이 없습니다.</div>'}
      <div class="kv"><span>다음 자료 받기</span><b>${nextDue ? fmtMD(nextDue) + (nextDue <= today ? ' (지남)' : '') : '첫 자료를 넣어주세요'}</b></div>
    </section>
  </div>`;
};

function nextImportDue() {
  const imps = live('imports');
  if (!imps.length) return '';
  const last = imps.map(i => i.at.slice(0, 10)).sort().pop();
  return addDays(last, Number(S().settings.cycleDays) || 15);
}

function occTable(M, list, full) {
  ui.occ.clear();
  if (!list.length) return '<div class="muted">예정된 항목이 없습니다.</div>';
  return `<table class="tbl"><thead><tr><th class="ck">완료</th><th>날짜</th><th>내용</th><th>통장</th><th class="r">입금</th><th class="r">출금</th>${full ? '<th class="r">예상 잔액</th><th></th>' : ''}</tr></thead><tbody>
  ${list.map(o => {
    ui.occ.set(o.key, o);
    const hint = planHint(M, o);
    const kindTag = o.kind === 'in' ? tag(o.conf === 'confirmed' ? '확정 수금' : '예상 수금', o.conf === 'confirmed' ? 'green' : 'gray') : '';
    const tags = [o.overdue && !o.done && !o.chk ? tag('지연', 'red') : '', occTags(o), kindTag, statusTag(o)].join(' ');
    const btn = (a, label) => `<button class="sm ghost" data-act="${a}" data-key="${esc(o.key)}">${label}</button>`;
    const act = full ? `<td class="act">${[
      (o.src === 'rec' || o.recId) && !o.done ? btn('occEdit', '이번 달만 바꾸기') : '',
      (o.src === 'rec' || o.src === 'plan') && !o.done && !o.invoiceId ? btn('occPart', '일부 입력') : '',
      o.src === 'rec' ? btn('occSkip', '이번만 건너뛰기') : '',
      o.src === 'plan' && o.recId ? btn('occReset', '원래대로') : '',
      o.src === 'plan' && o.kind === 'in' ? btn('planConf', o.conf === 'confirmed' ? '예상으로' : '확정으로') : '',
      o.src === 'plan' && !o.recId ? `<button class="sm ghost" data-act="planDel" data-id="${esc(o.planId)}">삭제</button>` : '',
    ].join('')}</td>` : '';
    return `<tr class="${o.done ? 'done' : ''}">
      <td class="ck">${o.src === 'vat' ? '' : `<input type="checkbox" data-chg="occDone" data-key="${esc(o.key)}" ${o.done ? 'checked' : ''} ${o.doneBy === 'bank' || o.doneBy === 'invoice' ? 'disabled' : ''} aria-label="완료">`}</td>
      <td>${o.noDate ? '<span class="muted">미정</span>' : fmtMD(o.date)}</td>
      <td>${esc(o.title)} ${tags}${hint && !o.chk ? `<div class="hint">통장에 같은 금액 ${o.kind === 'in' ? '입금' : '출금'} 있음 (${fmtMD(hint.date)} ${esc(acctName(M, hint.acct))}) → 맞으면 완료 체크</div>` : ''}</td>
      <td>${o.acct ? esc(acctName(M, o.acct)) : '<span class="muted">-</span>'}</td>
      <td class="r">${o.kind === 'in' ? amt(o.done ? o.amount : left(o), 'in') : ''}</td>
      <td class="r">${o.kind === 'out' ? amt(o.done ? o.amount : left(o), 'out') : ''}</td>
      ${full ? `<td class="r">${o.after !== undefined ? won(o.after) : ''}</td>` : ''}${act}
    </tr>`;
  }).join('')}</tbody></table>`;
}

function chartSvg(p, minBal) {
  const W = 680, H = 200, L = 6, R = 6, T = 14, B = 22;
  const days = Math.max(1, dayDiff(p.from, p.to));
  const vals = p.pts.map(x => x.bal);
  if (minBal) vals.push(minBal);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pv = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  lo -= pv; hi += pv;
  const X = d => L + (W - L - R) * Math.min(days, Math.max(0, dayDiff(p.from, d))) / days;
  const Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let d = `M${X(p.from).toFixed(1)},${Y(p.start).toFixed(1)}`;
  for (const pt of p.pts.slice(1)) d += ` H${X(pt.date).toFixed(1)} V${Y(pt.bal).toFixed(1)}`;
  d += ` H${X(p.to).toFixed(1)}`;
  let ticks = '';
  if (days <= 40) {
    for (let k = 7; k < days; k += 7) { const ds = addDays(p.from, k); ticks += `<text x="${X(ds)}" y="${H - 6}" class="tick">${fmtMD(ds)}</text>`; }
  } else {
    let ym = addMonths(ymOf(p.from), 1);
    const step = days > 200 ? 2 : 1;
    for (let g = 0; g < 14 && `${ym}-01` <= p.to; g++, ym = addMonths(ym, step)) ticks += `<text x="${X(ym + '-01')}" y="${H - 6}" class="tick">${Number(ym.slice(5))}월</text>`;
  }
  const minLine = minBal ? `<line x1="${L}" x2="${W - R}" y1="${Y(minBal)}" y2="${Y(minBal)}" class="minline"/><text x="${L + 2}" y="${Y(minBal) - 4}" class="minlbl">최소 유지금액 ${won(minBal)}</text>` : '';
  const zero = lo < 0 && hi > 0 ? `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>` : '';
  const mx = X(p.min.date), my = Y(p.min.bal);
  const bad = (minBal && p.min.bal < minBal) || p.min.bal < 0;
  const label = `${fmtMD(p.min.date)} 최저 ${won(p.min.bal)}`;
  const tx = mx > W - 160 ? mx - 6 : mx + 6, anchor = mx > W - 160 ? 'end' : 'start';
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="예상 잔액 그래프">${zero}${minLine}<path d="${d}" class="line"/>${ticks}<circle cx="${mx}" cy="${my}" r="4" class="${bad ? 'bad' : 'low'}"/><text x="${tx}" y="${Math.max(12, my - 7)}" text-anchor="${anchor}" class="lowlbl ${bad ? 'bad' : ''}">${label}</text></svg>`;
}

// ───────── 자료 넣기 ─────────
VIEWS.import = M => {
  const hist = live('imports').sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40);
  const due = nextImportDue();
  return `
  <h1>자료 넣기</h1>
  <label class="drop" for="file">
    <b>엑셀 파일을 여기로 끌어다 놓거나 눌러서 고르세요</b>
    <span>은행 거래내역 (수협·농협·카카오뱅크·우체국), 홈택스 매출·매입 전자세금계산서 목록</span>
    <span class="muted">같은 기간 파일을 또 넣어도 같은 거래는 한 번만 들어갑니다.</span>
    <input type="file" id="file" multiple accept=".xls,.xlsx" data-chg="files">
  </label>
  ${ui.imports.map((p, i) => importCard(M, p, i)).join('')}
  <section class="card">
    <div class="row-h"><h2>가져온 기록</h2>${due ? `<span class="muted">다음 자료 받기: ${fmtMD(due)} (보름마다)</span>` : ''}</div>
    ${hist.length ? `<table class="tbl"><thead><tr><th>가져온 때</th><th>파일</th><th>종류</th><th>기간</th><th class="r">새로 추가</th><th class="r">중복 건너뜀</th><th>검증</th></tr></thead><tbody>
    ${hist.map(h => `<tr><td>${esc(h.at.slice(5, 16))}</td><td class="wrap">${esc(h.file)}</td><td>${h.type === 'bank' ? esc(acctName(M, h.acct)) : (h.kind === 'sales' ? '매출 계산서' : '매입 계산서')}</td><td>${fmtMD(h.from)}~${fmtMD(h.to)}</td><td class="r">${h.added}${h.updated ? ` (+수정 ${h.updated})` : ''}</td><td class="r">${h.dup}</td><td>${h.ok ? tag('일치', 'green') : tag('확인 필요', 'red')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="muted">아직 가져온 파일이 없습니다.</div>'}
  </section>`;
};

function importCard(M, p, i) {
  if (p.error) {
    const msg = p.error === 'ENCRYPTED'
      ? '암호가 걸린 파일입니다. 엑셀에서 열고 "다른 이름으로 저장"할 때 암호를 지운 뒤 다시 넣어주세요. (카카오뱅크 파일이 보통 이렇습니다)'
      : p.error;
    return `<section class="card imp err"><div class="row-h"><h3>${esc(p.file)}</h3><button class="sm ghost" data-act="impDrop" data-i="${i}">닫기</button></div><div class="errline">${esc(msg)}</div></section>`;
  }
  const r = p.res;
  const acct = p.acct;
  const cnt = r.type === 'bank' ? (acct ? previewCounts(r, acct) : null) : previewCounts(r);
  const title = r.type === 'bank' ? '은행 거래내역' : (r.kind === 'sales' ? '매출 전자세금계산서' : '매입 전자세금계산서');
  const n = (r.rows || r.list).length;
  return `<section class="card imp">
    <div class="row-h"><h3>${esc(p.file)}</h3><button class="sm ghost" data-act="impDrop" data-i="${i}">빼기</button></div>
    <div class="impgrid">
      <div><span class="muted">종류</span><b>${title}</b></div>
      ${r.type === 'bank' ? `<div><span class="muted">통장</span><select data-chg="impAcct" data-i="${i}">${acctOptions(M, acct, '통장을 고르세요')}</select></div>` : ''}
      <div><span class="muted">기간</span><b>${r.from} ~ ${r.to}</b></div>
      <div><span class="muted">건수</span><b>${n}건</b>${cnt ? ` <span class="muted">(새로 ${cnt.fresh} · 이미 있음 ${cnt.dup})</span>` : ''}</div>
    </div>
    <ul class="checks">${(r.checks || []).map(c => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}: ${esc(c.detail)}</li>`).join('')}</ul>
    <div class="btns"><button class="primary" data-act="impDo" data-i="${i}" ${r.type === 'bank' && !acct ? 'data-need="1"' : ''}>장부에 넣기</button></div>
  </section>`;
}

async function readFiles(files) {
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const res = parseFile(buf, f.name);
      if (res.error) ui.imports.push({ file: f.name, error: res.error });
      else ui.imports.push({ file: f.name, res, acct: res.type === 'bank' ? (BANK_TO_ACCT[res.bank] || '') : '' });
    } catch (e) {
      ui.imports.push({ file: f.name, error: '파일을 읽지 못했습니다: ' + e.message });
    }
  }
  if (location.hash !== '#import') location.hash = '#import'; else render();
}

// ───────── 통합 장부 ─────────
VIEWS.ledger = M => {
  const f = ui.ledger;
  const months = [...new Set(M.txns.map(t => ymOf(t.date)))].sort().reverse();
  const q = normName(f.q);
  const rows = [];
  for (const t of M.txns) {
    if (f.acct && t.acct !== f.acct) continue;
    if (f.month && ymOf(t.date) !== f.month) continue;
    if (f.kind === 'in' && !(t.in > 0)) continue;
    if (f.kind === 'out' && !(t.out !== 0)) continue;
    if (f.personal && !t.personal) continue;
    if (q && !normName(t.desc + ' ' + (t.note || '') + ' ' + t.memo).includes(q)) continue;
    rows.push({ t });
  }
  for (const m of M.manual) {
    if (m.linkTxn) continue;
    if (f.acct && m.acct !== f.acct) continue;
    if (f.month && ymOf(m.date) !== f.month) continue;
    if (f.kind === 'in') continue;
    if (f.personal && !m.personal) continue;
    if (q && !normName(m.memo).includes(q)) continue;
    rows.push({ m, ts: m.date + ' 99' });
  }
  rows.sort((a, b) => { const x = a.t ? a.t.ts : a.ts, y = b.t ? b.t.ts : b.ts; return x < y ? 1 : x > y ? -1 : (b.t?.ord || 0) - (a.t?.ord || 0); });
  const sumIn = rows.reduce((s, r) => s + (r.t ? r.t.in : 0), 0);
  const sumOut = rows.reduce((s, r) => s + (r.t ? r.t.out : r.m.amount), 0);
  const shown = rows.slice(0, f.limit);
  return `
  <h1>통합 장부</h1>
  <div class="filters">
    <select data-chg="lf" data-f="acct">${acctOptions(M, f.acct, '모든 통장')}</select>
    <select data-chg="lf" data-f="month"><option value="">모든 달</option>${months.map(m => `<option value="${m}" ${m === f.month ? 'selected' : ''}>${fmtYM(m)}</option>`).join('')}</select>
    <select data-chg="lf" data-f="kind"><option value="">입금·출금</option><option value="in" ${f.kind === 'in' ? 'selected' : ''}>입금만</option><option value="out" ${f.kind === 'out' ? 'selected' : ''}>출금만</option></select>
    <label class="chk"><input type="checkbox" data-chg="lf" data-f="personal" ${f.personal ? 'checked' : ''}> 개인 지출만</label>
    <input type="search" id="lq" placeholder="거래처·내용 검색" value="${esc(f.q)}" data-inp="lq">
  </div>
  <div class="sumbar">${rows.length}건 · 입금 <b class="in">${won(sumIn)}</b> · 출금 <b class="out">${won(sumOut)}</b></div>
  <table class="tbl ledger"><thead><tr><th>일시</th><th>통장</th><th>내용</th><th class="r">입금</th><th class="r">출금</th><th class="r">잔액</th><th></th></tr></thead><tbody>
  ${shown.map(r => r.t ? ledgerRow(M, r.t) : manualRow(M, r.m)).join('')}
  </tbody></table>
  ${rows.length > shown.length ? `<div class="btns"><button data-act="more">더 보기 (${rows.length - shown.length}건 남음)</button></div>` : ''}`;
};

function ledgerRow(M, t) {
  const f = M.info.get(t.id);
  const inv = M.inv.txInv.get(t.id);
  const tags = [
    f.card ? tag('카드') : '', f.cancel ? tag('승인취소', 'gray') : '', f.transfer ? tag('내 통장 이체', 'blue') : '', f.owner ? tag('대표 계좌', 'blue') : '',
    t.personal ? tag('개인', 'amber') : '', inv ? tag('계산서 ' + inv.length + '장', 'green') : '',
  ].join('');
  return `<tr class="${f.cancel ? 'dim' : ''}"><td class="nowrap">${tsLabel(t)}</td><td>${esc(acctName(M, t.acct))}</td>
    <td>${esc(t.desc)} ${tags}${t.note ? `<div class="hint">${esc(t.note)}</div>` : ''}</td>
    <td class="r">${t.in ? amt(t.in, 'in') : ''}</td><td class="r">${t.out ? amt(t.out, 'out') : ''}</td><td class="r muted">${won(t.bal)}</td>
    <td class="act">${t.out > 0 && !f.transfer && !f.cancel ? (costUsing(M, { txnId: t.id }) ? tag('원가', 'green') : `<button class="sm ghost" data-act="txCost" data-id="${t.id}" title="작업 원가로 등록">원가</button>`) : ''}<button class="sm ghost" data-act="txPersonal" data-id="${t.id}">${t.personal ? '사업으로' : '개인'}</button><button class="sm ghost" data-act="txNote" data-id="${t.id}">메모</button></td></tr>`;
}

function manualRow(M, m) {
  return `<tr class="manual"><td class="nowrap">${fmtMD(m.date)}</td><td>${esc(acctName(M, m.acct))}</td>
    <td>${esc(m.memo || '(메모 없음)')} ${tag('핸드폰 기록', 'blue')}${m.costId ? tag('원가', 'green') : ''}${m.personal ? tag('개인', 'amber') : ''}<div class="hint">통장 자료가 들어오면 같은 거래와 합칩니다</div></td>
    <td></td><td class="r">${amt(m.amount, 'out')}</td><td></td>
    <td class="act"><button class="sm ghost" data-act="manDel" data-id="${m.id}">삭제</button></td></tr>`;
}

// ───────── 검토 ─────────
VIEWS.review = M => {
  const items = M.review.filter(x => ui.review.showDismissed ? x.dismissed : !x.dismissed);
  const dismissedN = M.review.filter(x => x.dismissed).length;
  const sections = Object.entries(REVIEW_TYPES).map(([type, title]) => {
    const list = items.filter(x => x.type === type).sort((a, b) => b.sev - a.sev);
    if (!list.length) return '';
    return `<section class="card"><h2>${title} <span class="badge">${list.length}</span></h2>${list.slice(0, 60).map(it => reviewItem(M, it)).join('')}${list.length > 60 ? `<div class="muted">외 ${list.length - 60}건</div>` : ''}</section>`;
  }).join('');
  return `
  <h1>검토</h1>
  <div class="filters"><label class="chk"><input type="checkbox" data-chg="showDismissed" ${ui.review.showDismissed ? 'checked' : ''}> 확인 끝난 항목 보기 (${dismissedN})</label></div>
  ${sections || `<div class="okline">✓ ${ui.review.showDismissed ? '확인 끝난 항목이 없습니다.' : '검토할 항목이 없습니다.'}</div>`}`;
};

function reviewItem(M, it) {
  const ok = (label = '정상 (확인함)') => it.dismissed
    ? `<button class="sm ghost" data-act="undismiss" data-key="${esc(it.key)}">다시 검토</button>`
    : `<button class="sm" data-act="dismiss" data-key="${esc(it.key)}">${label}</button>`;
  switch (it.type) {
    case 'balance':
      return `<div class="ri"><div class="ri-t">${esc(acctName(M, it.acct))}: 계산한 잔액 ${won(it.expected)} / 은행 잔액 ${won(it.rows[1].bal)} (차이 ${won(it.diff)})</div>
        ${it.rows.map(t => txLine(M, t)).join('')}<div class="hint">이 두 거래 사이 기간의 거래내역 파일이 빠졌을 수 있습니다. 그 기간 엑셀을 넣으면 자동으로 해결됩니다.</div><div class="btns">${ok('확인함')}</div></div>`;
    case 'dup':
    case 'dbl':
      return `<div class="ri">${it.type === 'dbl' ? `<div class="ri-t">${it.days}일 간격으로 같은 금액</div>` : ''}${it.rows.map(t => txLine(M, t)).join('')}<div class="btns">${ok('정상 (따로따로 한 거래)')}</div></div>`;
    case 'group': {
      const sum = it.invs.reduce((s, i) => s + M.inv.st[i.id].eff, 0);
      return `<div class="ri"><div class="ri-t">${txLine(M, it.t)}</div>
        <div class="hint">아래 계산서 ${it.invs.length}장 합계 ${won(sum)}원이 이 ${it.kind === 'sales' ? '입금' : '송금'}액과 정확히 같습니다. 합계가 우연히 같을 수도 있으니 PO 번호로 확인해 주세요.</div>
        ${it.invs.map(i => `<div class="txline"><span class="d">${fmtMD(i.wdate)}</span><span class="t">${esc(i.name)} · ${esc(i.note || i.item)}</span><span class="num">${won(M.inv.st[i.id].eff)}</span></div>`).join('')}
        <div class="btns"><button class="sm primary" data-act="grpLink" data-t="${it.t.id}" data-ids="${esc(it.invs.map(i => i.id).join(','))}">맞음, 연결</button>${ok('아님')}</div></div>`;
    }
    case 'mlink':
      return `<div class="ri"><div class="ri-t">핸드폰 기록: ${fmtMD(it.m.date)} ${esc(acctName(M, it.m.acct))} ${esc(it.m.memo || '')} <b class="out">-${won(it.m.amount)}</b></div>
        ${it.rows.map(t => `<div class="pick">${txLine(M, t)}<button class="sm primary" data-act="mlink" data-m="${it.m.id}" data-t="${t.id}">이 거래와 같음</button></div>`).join('')}<div class="btns">${ok('다른 거래임')}</div></div>`;
    case 'morph':
      return `<div class="ri"><div class="ri-t">${fmtMD(it.m.date)} ${esc(acctName(M, it.m.acct))} ${esc(it.m.memo || '')} <b class="out">-${won(it.m.amount)}</b></div>
        <div class="hint">통장 자료에 같은 금액 출금이 없습니다. 다른 통장으로 냈거나 금액을 잘못 적었을 수 있습니다.</div>
        <div class="btns"><button class="sm" data-act="manDel" data-id="${it.m.id}">기록 삭제</button>${ok('그대로 두기')}</div></div>`;
    case 'xfer':
      return `<div class="ri"><div class="ri-t">금액·날짜는 같지만 이름으로는 내 통장 이체인지 알 수 없습니다. 이체가 맞으면 매출·비용에서 빠집니다.</div>
        ${it.rows.filter(Boolean).map(t => txLine(M, t)).join('')}
        <div class="btns"><button class="sm primary" data-act="xferYes" data-t="${it.rows[0].id}">맞음, 내 통장 이체</button>${ok('아님 (각각 다른 거래)')}</div></div>`;
    case 'unpaidSales':
    case 'unpaidPurchase': {
      const i = it.inv;
      const word = it.type === 'unpaidSales' ? '수금' : '지급';
      return `<div class="ri"><div class="ri-t">${fmtMD(i.wdate)} ${esc(i.name)} ${it.paid ? '잔액 ' : ''}<b>${won(it.eff)}</b>${it.paid ? ` ${tag(`일부 ${word} ${won(it.paid)} / 전체 ${won(it.total)}`, 'amber')}` : ''} · ${it.age}일 지남</div>
        <div class="hint">${esc([i.item, i.note].filter(Boolean).join(' / '))}</div>
        ${it.sugg.map(t => `<div class="pick">${txLine(M, t)}<button class="sm primary" data-act="invLink" data-inv="${esc(i.id)}" data-t="${t.id}">이 거래로 연결</button></div>`).join('')}
        ${(it.part || []).length ? `<div class="hint">같은 거래처에서 나눠서 ${word}된 것 같은 거래 (연결하면 "일부 ${word}"으로 표시되고 잔액이 남습니다)</div>` : ''}
        ${(it.part || []).map(t => `<div class="pick">${txLine(M, t)}<button class="sm" data-act="invLink" data-inv="${esc(i.id)}" data-t="${t.id}">일부로 연결</button></div>`).join('')}
        <div class="btns"><button class="sm" data-act="invSettle" data-id="${esc(i.id)}">정산 완료로 처리</button>${ok('나중에 보기')}</div></div>`;
    }
    case 'noinv': {
      const t = it.rows[0];
      const sales = partners(M).filter(p => p.sales);
      return `<div class="ri">${txLine(M, t)}<div class="btns">
        <select data-chg="aliasSet" data-n="${esc(M.info.get(t.id).n)}"><option value="">이 입금자는 어느 거래처?</option>${sales.map(p => `<option value="${esc(p.biz)}">${esc(p.name)}</option>`).join('')}</select>
        ${ok('정상 (계산서 필요 없음)')}</div></div>`;
    }
    default:
      return '';
  }
}

// ───────── 자금 계획 ─────────
VIEWS.plan = M => {
  const s = S();
  const days = ui.plan.days;
  const p = projection(s, M, days);
  const minBal = s.settings.minBalance || 0;
  const all = occurrences(s, M, p.from, p.to).filter(o => s.settings.includePersonal || !o.personal);
  const after = new Map(p.evs.map(e => [e.key, e.after]));
  for (const o of all) o.after = after.get(o.key);
  const openInv = M.inv.list.filter(i => M.inv.st[i.id].remain > 0 && !live('plans').some(pl => pl.invoiceId === i.id))
    .sort((a, b) => (a.wdate < b.wdate ? -1 : 1));
  const today = todayStr();
  return `
  <h1>자금 계획</h1>
  <div class="filters">
    ${[[30, '1개월'], [90, '3개월'], [365, '1년']].map(([d, l]) => `<button class="${d === days ? 'primary' : ''}" data-act="planDays" data-d="${d}">${l}</button>`).join('')}
    <label class="inl">최소 유지금액 <input type="text" inputmode="numeric" id="minbal" value="${minBal ? won(minBal) : ''}" placeholder="0" data-chg="minBal"></label>
    <label class="chk"><input type="checkbox" data-chg="inclPersonal" ${s.settings.includePersonal ? 'checked' : ''}> 개인 지출 포함</label>
  </div>
  <div class="grid5">
    <div class="mc"><div class="l">지금 잔액 (추정)</div><div class="v">${won(p.start)}</div></div>
    <div class="mc"><div class="l">확정 입금</div><div class="v in">${won(p.inSum)}</div>${p.expIn ? `<div class="s">예상 ${won(p.expIn)} 별도</div>` : ''}</div>
    <div class="mc"><div class="l">예정 출금</div><div class="v out">${won(p.outSum)}</div></div>
    <div class="mc"><div class="l">${days === 365 ? '1년' : days === 90 ? '3개월' : '1개월'} 뒤 예상</div><div class="v">${won(p.end)}</div></div>
    <div class="mc ${(minBal && p.min.bal < minBal) || p.min.bal < 0 ? 'bad' : ''}"><div class="l">가장 낮은 날</div><div class="v">${won(p.min.bal)}</div><div class="s">${fmtMD(p.min.date)}</div></div>
  </div>
  <section class="card">${chartSvg(p, minBal)}
    ${minBal && p.min.bal < minBal ? `<div class="errline">${fmtMD(p.min.date)}에 최소 유지금액보다 ${won(minBal - p.min.bal)}원 부족할 것으로 예상됩니다. 입금 일정을 당기거나 지출을 미뤄야 합니다.</div>` : ''}
    <div class="hint">고정 지출은 매달 자동으로 들어갑니다. 부가세는 홈택스 계산서 기준 예상액입니다. 미수금은 아래에서 "계획에 넣기"를 해야 반영됩니다.
    ${p.expIn ? `<b>예상 수금 ${won(p.expIn)}원은 그래프와 예상 잔액에 넣지 않았습니다</b> (확정으로 바꾸면 들어갑니다).` : ''}</div>
  </section>
  <section class="card">
    <h2>예정 항목 추가</h2>
    <div class="form">
      <input type="date" id="pl-date" value="${today}" title="날짜를 지우면 '지급일 확인 필요'로 들어갑니다">
      <select id="pl-kind">
        <option value="out:direct">보낼 돈 · 직접 이체</option><option value="out:auto">보낼 돈 · 자동이체</option><option value="out:card">보낼 돈 · 카드 결제</option>
        <option value="in:confirmed">받을 돈 · 확정</option><option value="in:expected">받을 돈 · 예상</option>
      </select>
      <input type="text" id="pl-amt" inputmode="numeric" placeholder="금액">
      <input type="text" id="pl-title" placeholder="내용 (예: PO 번호, 거래처)">
      <select id="pl-acct">${acctOptions(M, '', '통장 미정')}</select>
      <label class="chk"><input type="checkbox" id="pl-personal"> 개인</label>
      <button class="primary" data-act="planAdd">추가</button>
    </div>
    <div class="hint">날짜 칸을 비우면 "지급일(수금일) 확인 필요"로 들어가고, 합계와 그래프에는 넣지 않습니다.</div>
  </section>
  <section class="card"><h2>예정 목록</h2>${occTable(M, all, true)}</section>
  ${openInv.length ? `<section class="card"><h2>미수금·미지급 → 계획에 넣기</h2><div class="hint">세금계산서는 있는데 아직 돈이 오가지 않은 건입니다. 예상 날짜를 정해 계획에 넣으면 잔액 예측에 들어갑니다.</div>
    <table class="tbl"><thead><tr><th>구분</th><th>작성일</th><th>거래처</th><th>비고</th><th class="r">금액</th><th>예상 날짜</th><th></th></tr></thead><tbody>
    ${openInv.slice(0, 60).map(i => { const d = addDays(i.wdate, 30) < today ? addDays(today, 7) : addDays(i.wdate, 30); return `<tr><td>${i.kind === 'sales' ? tag('미수', 'green') : tag('미지급', 'red')}</td><td>${fmtMD(i.wdate)}</td><td>${esc(i.name)}</td><td class="wrap muted">${esc(i.note || i.item)}</td><td class="r">${won(M.inv.st[i.id].remain)}${M.inv.st[i.id].state === 'partial' ? `<div class="muted s">일부 ${won(M.inv.st[i.id].paid)} 받음·보냄</div>` : ''}</td><td><input type="date" id="ivd-${esc(i.id)}" value="${d}"></td><td><button class="sm" data-act="invPlan" data-id="${esc(i.id)}">계획에 넣기</button></td></tr>`; }).join('')}
    </tbody></table></section>` : ''}`;
};

// ───────── 세금계산서 ─────────
VIEWS.invoices = M => {
  const s = S();
  const periods = vatPeriods(s, M);
  if (!ui.inv.period && periods.length) ui.inv.period = periods[0].key;
  const per = periods.find(p => p.key === ui.inv.period);
  const inPer = i => { if (!per) return true; const y = +i.wdate.slice(0, 4), h = Number(i.wdate.slice(5, 7)) <= 6 ? 'H1' : 'H2'; return y === per.y && h === per.h; };
  const today = todayStr();
  const list = M.inv.list.filter(i => i.kind === ui.inv.kind && inPer(i))
    .filter(i => { const r = M.inv.st[i.id].remain > 0; return !ui.inv.status || (ui.inv.status === 'open' ? r : !r); })
    .sort((a, b) => (a.wdate < b.wdate ? 1 : -1));
  const status = i => {
    const st = M.inv.st[i.id];
    if (st.state === 'paid') return st.how === 'settled' ? tag('정산 처리', 'gray') : tag(`${i.kind === 'sales' ? '입금' : '송금'} ${fmtMD(st.date)}${st.how === 'group' ? ' (묶음)' : st.how === 'manual' ? ' (직접 연결)' : ''}`, 'green');
    if (st.state === 'open') return tag(`${i.kind === 'sales' ? '미수' : '미지급'} ${dayDiff(i.wdate, today)}일`, 'red');
    if (st.state === 'partial') return tag(`일부 ${i.kind === 'sales' ? '수금' : '지급'} ${won(st.paid)} · 잔액 ${won(st.remain)}`, 'amber');
    if (st.state === 'cancel') return tag('취소됨', 'gray');
    if (st.state === 'corr') return tag('수정분', 'gray');
    if (st.state === 'receipt') return tag('영수 (결제하고 받음)', 'gray');
    return tag('해당없음', 'gray');
  };
  const act = i => {
    const st = M.inv.st[i.id];
    if (st.state === 'open') return `<button class="sm" data-act="invSettle" data-id="${esc(i.id)}">정산 완료</button>`;
    if (st.state === 'partial') return `<button class="sm" data-act="invSettle" data-id="${esc(i.id)}">잔액 정산 완료</button><button class="sm ghost" data-act="invReset" data-id="${esc(i.id)}">연결 풀기</button>`;
    if (st.state === 'paid' && (st.how === 'settled' || st.how === 'manual')) return `<button class="sm ghost" data-act="invReset" data-id="${esc(i.id)}">되돌리기</button>`;
    if (st.state === 'paid') return `<button class="sm ghost" data-act="invNoAuto" data-id="${esc(i.id)}">자동 연결 틀림</button>`;
    return i.noAuto ? `<button class="sm ghost" data-act="invReset" data-id="${esc(i.id)}">자동 연결 다시</button>` : '';
  };
  const sum = k => list.reduce((s2, i) => s2 + i[k], 0);
  return `
  <h1>세금계산서</h1>
  <div class="filters">
    <select data-chg="invPeriod">${periods.map(p => `<option value="${p.key}" ${p.key === ui.inv.period ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
    <button class="${ui.inv.kind === 'sales' ? 'primary' : ''}" data-act="invKind" data-k="sales">매출</button>
    <button class="${ui.inv.kind === 'purchase' ? 'primary' : ''}" data-act="invKind" data-k="purchase">매입</button>
    <select data-chg="invStatus"><option value="">전체</option><option value="open" ${ui.inv.status === 'open' ? 'selected' : ''}>${ui.inv.kind === 'sales' ? '미수만' : '미지급만'}</option><option value="done" ${ui.inv.status === 'done' ? 'selected' : ''}>완료만</option></select>
  </div>
  ${per ? `<section class="card"><h2>부가세 예상 · ${per.label}</h2>
    <div class="grid5">
      <div class="mc"><div class="l">매출 세액</div><div class="v">${won(per.salesTax)}</div></div>
      <div class="mc"><div class="l">매입 세액</div><div class="v">${won(per.purchTax)}</div></div>
      <div class="mc"><div class="l">이미 낸 금액 (예정고지 등)</div><div class="v"><input type="text" inputmode="numeric" id="vatpre" value="${per.prepaid ? won(per.prepaid) : ''}" placeholder="0" data-chg="vatPrepaid" data-k="${per.key}"></div></div>
      <div class="mc ${per.est > 0 ? 'bad' : ''}"><div class="l">예상 납부액</div><div class="v">${won(per.est)}</div><div class="s">납부기한 ${per.due}</div></div>
    </div>
    <div class="hint">홈택스 전자세금계산서만으로 계산한 값입니다. 카드 매입 공제, 가산세 등은 빠져 있어 실제 신고액과 다를 수 있습니다.</div></section>` : ''}
  <div class="sumbar">${list.length}장 · 공급가액 ${won(sum('supply'))} · 세액 ${won(sum('tax'))} · 합계 <b>${won(sum('total'))}</b></div>
  <table class="tbl"><thead><tr><th>작성일</th><th>거래처</th><th>품목·비고</th><th class="r">공급가액</th><th class="r">세액</th><th class="r">합계</th><th>상태</th><th></th></tr></thead><tbody>
  ${list.map(i => `<tr><td class="nowrap">${fmtMD(i.wdate)}</td><td>${esc(i.name)}</td><td class="wrap muted">${esc([i.item, i.note].filter(Boolean).join(' / '))}</td><td class="r">${won(i.supply)}</td><td class="r">${won(i.tax)}</td><td class="r">${won(i.total)}</td><td>${status(i)}</td><td class="act">${act(i)}${i.kind === 'purchase' && M.inv.st[i.id].state !== 'corr' ? (costUsing(M, { invoiceId: i.id }) ? tag('원가', 'green') : `<button class="sm ghost" data-act="invCost" data-id="${esc(i.id)}" title="작업 원가로 등록">원가</button>`) : ''}</td></tr>`).join('')}
  </tbody></table>`;
};

// ───────── 카드 사용 ─────────
VIEWS.cards = M => {
  const usage = cardUsage(M);
  const lastYm = M.txns.length ? ymOf(M.txns[M.txns.length - 1].date) : ymOf(todayStr());
  const months = [];
  for (let k = 5; k >= 0; k--) months.push(addMonths(lastYm, -k));
  const sel = ui.cards.sel;
  const merch = sel ? cardMerchants(M, sel.acct, sel.ym) : [];
  return `
  <h1>카드 사용 (체크카드 사용자별 월별)</h1>
  <div class="hint">통장 거래 중 체크카드 결제만 모았습니다. 승인 후 취소된 건은 서로 빼서 계산합니다. 숫자를 누르면 어디에 썼는지 보입니다.</div>
  <table class="tbl"><thead><tr><th>통장 · 사용자</th>${months.map(m => `<th class="r">${fmtYM(m)}</th>`).join('')}</tr></thead><tbody>
  ${M.accounts.map(a => `<tr><td>${esc(acctLabel(a))}</td>${months.map(m => { const r = usage[a.id]?.[m]; const on = sel && sel.acct === a.id && sel.ym === m; return `<td class="r">${r && r.card ? `<button class="link ${on ? 'on' : ''}" data-act="cardSel" data-a="${a.id}" data-m="${m}">${won(r.card)}</button><div class="muted s">${r.cardN}건</div>` : '<span class="muted">-</span>'}</td>`; }).join('')}</tr>`).join('')}
  <tr class="sub"><td>통장 전체 출금 (이체 제외)</td>${months.map(m => `<td class="r muted">${won(M.accounts.reduce((s, a) => s + (usage[a.id]?.[m]?.out || 0), 0))}</td>`).join('')}</tr>
  </tbody></table>
  ${sel ? `<section class="card"><h2>${esc(acctName(M, sel.acct))} · ${fmtYM(sel.ym)} 사용처</h2>
    <table class="tbl"><thead><tr><th>사용처</th><th class="r">건수</th><th class="r">금액</th></tr></thead><tbody>
    ${merch.map(r => `<tr><td>${esc(r.name)}</td><td class="r">${r.n}</td><td class="r">${won(r.amount)}</td></tr>`).join('')}
    </tbody></table></section>` : ''}`;
};

// ───────── 고정 지출 ─────────
VIEWS.recurring = M => {
  const recs = live('recurring').sort((a, b) => (a.day || 0) - (b.day || 0));
  const sugg = recurringSuggestions(S(), M);
  ui.recSugg = sugg;
  const total = recs.filter(r => r.active !== false && (r.kind || 'out') === 'out').reduce((s, r) => s + r.amount, 0);
  return `
  <h1>고정 지출 (매달 반복)</h1>
  <div class="hint">여기 등록한 항목은 자금 계획에 매달 자동으로 들어갑니다. 금액·날짜는 칸을 바로 고치면 저장됩니다.
  "통장 표시 이름"을 넣어두면 그 이름으로 통장에 찍힌 출금을 찾아 자동으로 "대조 완료" 처리합니다 (금액이 달라도 실제 금액을 따로 보여줌).
  한 달 금액을 바꿀 때는 자금 계획의 "이번 달만 바꾸기"를 쓰세요. 여기 금액은 앞으로의 예상액입니다.</div>
  <section class="card">
    <div class="sumbar">${recs.length}개 · 매달 출금 합계 <b class="out">${won(total)}</b> · 그중 직접 보낼 돈 <b>${won(recs.filter(r => r.active !== false && (r.kind || 'out') === 'out' && (r.pay || 'direct') === 'direct').reduce((s2, r) => s2 + r.amount, 0))}</b></div>
    <table class="tbl"><thead><tr><th>사용</th><th>내용</th><th>매달</th><th class="r">예상액</th><th>입·출</th><th>방식</th><th>통장 표시 이름</th><th>통장</th><th>개인</th><th></th></tr></thead><tbody>
    ${recs.map(r => `<tr class="${r.active === false ? 'dim' : ''}">
      <td><input type="checkbox" data-chg="recField" data-id="${r.id}" data-f="active" ${r.active !== false ? 'checked' : ''}></td>
      <td><input type="text" value="${esc(r.title)}" data-chg="recField" data-id="${r.id}" data-f="title"></td>
      <td><input type="number" min="1" max="31" class="w4" value="${r.day}" data-chg="recField" data-id="${r.id}" data-f="day">일</td>
      <td class="r"><input type="text" inputmode="numeric" class="r w8" value="${won(r.amount)}" data-chg="recField" data-id="${r.id}" data-f="amount"></td>
      <td><select data-chg="recField" data-id="${r.id}" data-f="kind"><option value="out">출금</option><option value="in" ${r.kind === 'in' ? 'selected' : ''}>입금</option></select></td>
      <td>${r.kind === 'in' ? '' : `<select data-chg="recField" data-id="${r.id}" data-f="pay">${Object.entries(PAY).map(([k, l]) => `<option value="${k}" ${(r.pay || 'direct') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</td>
      <td><input type="text" class="w8" value="${esc(r.bankName || '')}" placeholder="예: LGU+" data-chg="recField" data-id="${r.id}" data-f="bankName"></td>
      <td><select data-chg="recField" data-id="${r.id}" data-f="acct">${acctOptions(M, r.acct, '미정')}</select></td>
      <td><input type="checkbox" data-chg="recField" data-id="${r.id}" data-f="personal" ${r.personal ? 'checked' : ''}></td>
      <td class="act"><button class="sm ghost" data-act="recDel" data-id="${r.id}">삭제</button></td></tr>`).join('')}
    </tbody></table>
    <div class="form">
      <input type="text" id="rc-title" placeholder="내용 (예: 사무실 임대료)">
      <input type="number" id="rc-day" min="1" max="31" placeholder="매달 며칠" class="w6">
      <input type="text" id="rc-amt" inputmode="numeric" placeholder="금액">
      <select id="rc-kind"><option value="out">출금</option><option value="in">입금</option></select>
      <select id="rc-pay">${Object.entries(PAY).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <input type="text" id="rc-bank" placeholder="통장 표시 이름 (선택)" class="w8">
      <select id="rc-acct">${acctOptions(M, '', '통장 미정')}</select>
      <label class="chk"><input type="checkbox" id="rc-personal"> 개인</label>
      <button class="primary" data-act="recAdd">추가</button>
    </div>
  </section>
  ${sugg.length ? `<section class="card"><h2>통장에서 찾은 반복 출금 (추천)</h2><div class="hint">최근 몇 달 동안 비슷한 금액으로 3번 이상 나간 출금입니다. 고정 지출이 맞으면 추가하세요.</div>
    <table class="tbl"><thead><tr><th>내용</th><th>매달</th><th class="r">최근 금액</th><th>통장</th><th>방식 (추정)</th><th>나온 달 수</th><th></th></tr></thead><tbody>
    ${sugg.slice(0, 40).map((r, k) => `<tr><td>${esc(r.title)}</td><td>${r.day}일 무렵</td><td class="r">${won(r.amount)}</td><td>${esc(acctName(M, r.acct))}</td><td>${PAY[r.pay]}</td><td>${r.months}개월</td><td><button class="sm" data-act="recAddSug" data-i="${k}">추가</button></td></tr>`).join('')}
    </tbody></table></section>` : ''}`;
};

// ───────── 거래처 ─────────
VIEWS.partners = M => {
  const q = normName(ui.partners.q);
  const list = partners(M).filter(p => !q || normName(p.name).includes(q));
  return `
  <h1>거래처</h1>
  <div class="filters"><input type="search" id="pq" placeholder="거래처 검색" value="${esc(ui.partners.q)}" data-inp="pq"></div>
  <table class="tbl"><thead><tr><th>거래처</th><th>사업자번호</th><th class="r">매출 합계</th><th class="r">매입 합계</th><th class="r">미수금</th><th class="r">미지급</th><th>최근</th></tr></thead><tbody>
  ${list.map(p => `<tr><td>${esc(p.name)}</td><td class="muted">${esc(p.biz)}</td><td class="r">${p.sales ? won(p.sales) : ''}</td><td class="r">${p.purchase ? won(p.purchase) : ''}</td><td class="r">${p.recv ? `<b class="red">${won(p.recv)}</b>` : ''}</td><td class="r">${p.pay ? `<b class="red">${won(p.pay)}</b>` : ''}</td><td>${fmtMD(p.last)}</td></tr>`).join('')}
  </tbody></table>`;
};

// ───────── 설정 ─────────
VIEWS.settings = M => {
  const s = S();
  const st = drive.sync;
  return `
  <h1>설정</h1>
  <section class="card"><h2>구글 드라이브 저장</h2>
    <div class="kv"><span>상태</span><b>${{ ok: '연결됨 · 저장됨', syncing: '저장 중', offline: '오프라인', error: '오류: ' + esc(st.msg), needLogin: '다시 연결 필요', off: '연결 안 됨' }[st.status] || st.status}</b></div>
    ${st.lastAt ? `<div class="kv"><span>마지막 저장</span><b>${new Date(st.lastAt).toLocaleString('ko-KR')}</b></div>` : ''}
    <div class="hint">장부는 내 드라이브의 "에스튜브 경리 앱 데이터" 폴더에만 저장됩니다. 하루 한 번 백업 파일이 따로 생깁니다 (최근 60개 보관).</div>
    <div class="btns">${st.status === 'off' || st.status === 'needLogin' ? '<button class="primary" data-act="connect">구글 드라이브 연결</button>' : '<button data-act="sync">지금 저장</button> <button class="ghost" data-act="disconnect">연결 끊기</button>'}</div>
  </section>
  <section class="card"><h2>통장과 체크카드 사용자</h2>
    <table class="tbl"><thead><tr><th>통장</th><th>체크카드 사용자</th></tr></thead><tbody>
    ${M.accounts.map(a => `<tr><td><input type="text" value="${esc(a.name)}" data-chg="acctField" data-id="${a.id}" data-f="name"></td><td><input type="text" value="${esc(a.holder || '')}" placeholder="예: 홍길동 과장" data-chg="acctField" data-id="${a.id}" data-f="holder"></td></tr>`).join('')}
    </tbody></table>
  </section>
  <section class="card"><h2>자료 받기 주기</h2>
    <label class="inl"><input type="number" class="w4" min="1" max="60" value="${s.settings.cycleDays || 15}" data-chg="cycleDays"> 일마다 홈택스·은행 자료 받기</label>
  </section>
  <section class="card"><h2>백업과 내보내기</h2>
    <div class="btns">
      <button data-act="exportXlsx">장부를 엑셀로 내보내기</button>
      <button data-act="exportJson">백업 파일 내려받기</button>
      <label class="btn">백업 파일로 되돌리기<input type="file" accept=".json" data-chg="importJson" hidden></label>
    </div>
    <div class="hint">백업 파일로 되돌리면 지금 자료와 합쳐집니다 (지워지지 않음).</div>
  </section>
  <section class="card"><h2>이 기기 자료 지우기</h2>
    <div class="hint">이 컴퓨터(또는 핸드폰)에 저장된 자료만 지웁니다. 구글 드라이브의 자료는 그대로이고, 다시 연결하면 내려받습니다.</div>
    <div class="btns"><button class="danger" data-act="resetLocal">이 기기 자료 지우기</button></div>
  </section>`;
};

VIEWS.jobs = M => jobsView(M);

VIEWS.work = () => `
  <h1>업무관리</h1>
  <section class="card"><h2>2단계에서 옮겨옵니다</h2>
  <div class="hint">기존 S-TUBE 업무관리 앱의 기능(현장·견적·PO·업무 흐름)을 이 앱 안으로 옮기는 작업은 경리 기능이 자리잡은 뒤 진행합니다.
  그 전까지는 세금계산서 비고의 PO 번호와 자금 계획의 PO 항목으로 연결해서 봅니다.</div></section>`;

// ───────── 핸드폰 화면 ─────────
function mobile(route, M) {
  const head = `<header class="mtop"><a href="#m" class="brand">S-TUBE 경리</a><span id="msync">${syncBadge()}</span></header>`;
  if (route === 'm-add') return `<div class="m">${head}${costAddView(M)}</div>`;
  ui.occ.clear();
  const open = M.review.filter(x => !x.dismissed).length;
  return `<div class="m">${head}
    <div class="row2"><a class="mbtn" href="#m-add" data-act="mAdd" data-m="new">+ 지출·증빙 기록</a><a class="mbtn ghost" href="#m-add" data-act="mAdd" data-m="attach">📎 증빙만 붙이기</a></div>
    <h2 class="msect">오늘 할 일 <span class="muted s">(받을 돈은 체크하면 입금 확인)</span></h2>
    ${todayPanel(M, true)}
    <section class="mcard">
      <div class="muted">통장 잔액 합계</div><div class="big">${won(M.totalEst)}원</div>
      ${M.accounts.map(a => { const b = M.balances[a.id]; return `<div class="kv"><span>${esc(acctLabel(a))}</span><b>${b.bal === null ? '-' : won(b.est)}</b></div>`; }).join('')}
    </section>
    ${M.manual.filter(m => !m.linkTxn).length ? `<section class="mcard"><h2>최근 지출 기록</h2>${M.manual.filter(m => !m.linkTxn).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8).map(m => `<div class="mrow"><span class="d">${fmtMD(m.date)}</span><span class="t">${esc(acctName(M, m.acct))} ${esc(m.memo || '')}</span><span class="num out">-${won(m.amount)}</span></div>`).join('')}</section>` : ''}
    ${open ? `<div class="note">검토할 항목 ${open}건 · PC에서 확인하세요</div>` : ''}
    <a class="mlink" href="#home">PC 화면 (전체 메뉴)</a>
    <div class="muted s" style="text-align:center;margin:8px 0">앱 버전 ${BUILD}</div>
  </div>`;
}

function mobileAdd(M) {
  const a = ui.add;
  if (!a.acct && M.accounts.length) a.acct = M.accounts[0].id;
  if (!a.date) a.date = todayStr();
  const n = parseWonInput(a.amount || '0');
  return `<section class="mcard add">
    <div class="muted">지출 기록</div>
    <div class="amtdisp">${a.amount ? won(n) : '0'}<span>원</span></div>
    <div class="pills">${M.accounts.map(x => `<button class="pill ${x.id === a.acct ? 'on' : ''}" data-act="addAcct" data-a="${x.id}">${esc(x.name)}</button>`).join('')}</div>
    <input type="text" id="add-memo" placeholder="메모 (예: 현장 식대)" value="${esc(a.memo)}" data-inp="addMemo">
    <div class="row2"><input type="date" id="add-date" value="${a.date}" data-chg="addDate"><label class="chk"><input type="checkbox" data-chg="addPersonal" ${a.personal ? 'checked' : ''}> 개인 지출</label></div>
    <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '←'].map(k => `<button data-act="np" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="row2"><a class="mbtn ghost" href="#m">취소</a><button class="mbtn" data-act="addSave">저장</button></div>
  </section>`;
}

// ───────── 동작 ─────────
function occByKey(key) { return ui.occ.get(key); }
// 계산서의 기존 연결 (예전 방식 linkTxns는 계산된 배분 금액으로 바꿔서 유지)
const linksOf = i => (i.links && i.links.length ? i.links : (model().inv.st[i.id]?.how === 'manual' ? model().inv.st[i.id].alloc.map(a => ({ t: a.t, amt: a.amt })) : []));

// 고정 항목의 "이번 달" 기록 (이번 달 값만 바뀌고 고정 항목의 예상액·다음 달은 그대로)
const recRow = o => ({ id: o.key, recId: o.recId, ym: o.ym, date: o.date, kind: o.kind, amount: o.amount, title: o.title, acct: o.acct, cat: o.cat, personal: o.personal, pay: o.pay, conf: o.conf, bankName: o.bankName });

function setOccDone(o, done) {
  const by = { done, doneBy: done ? 'user' : '', doneAt: done ? nowTs() : '' };
  if (o.src === 'plan') patch('plans', o.planId, by);
  else if (o.src === 'rec') put('plans', { ...recRow(o), ...by });
  commit('plan');
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const ACT = {
  connect: () => { drive.connect().catch(() => toast('구글 연결이 취소되었거나 실패했습니다')); },
  sync: () => drive.syncNow(),
  disconnect: () => { if (confirm('구글 드라이브 연결을 끊을까요? (드라이브 자료는 지워지지 않습니다)')) { drive.disconnect(); render(); } },
  impDrop: el => { ui.imports.splice(+el.dataset.i, 1); render(); },
  impDo: el => {
    const p = ui.imports[+el.dataset.i];
    if (!p || !p.res) return;
    if (p.res.type === 'bank' && !p.acct) { toast('어느 통장인지 먼저 골라주세요'); return; }
    const bad = (p.res.checks || []).filter(c => !c.ok);
    if (bad.length && !confirm(`검증에서 맞지 않는 항목이 있습니다:\n${bad.map(c => c.label + ': ' + c.detail).join('\n')}\n\n그래도 넣을까요?`)) return;
    const r = commitImport(p.res, p.file, p.acct);
    ui.imports.splice(+el.dataset.i, 1);
    toast(`새로 ${r.added}건 추가${r.updated ? `, 수정 ${r.updated}건` : ''}, 이미 있던 ${r.dup}건은 건너뜀`);
  },
  more: () => { ui.ledger.limit += 300; render(); },
  txPersonal: el => { const t = S().txns[el.dataset.id]; patch('txns', t.id, { personal: !t.personal }); commit('tx'); },
  txNote: el => { const t = S().txns[el.dataset.id]; const v = prompt('메모', t.note || ''); if (v !== null) { patch('txns', t.id, { note: v.trim() }); commit('tx'); } },
  manDel: el => { if (confirm('이 핸드폰 기록을 삭제할까요?')) { remove('manual', el.dataset.id); commit('manual'); } },
  dismiss: el => { put('decisions', { id: el.dataset.key, v: 'ok' }); commit('review'); },
  undismiss: el => { remove('decisions', el.dataset.key); commit('review'); },
  mlink: el => { patch('manual', el.dataset.m, { linkTxn: el.dataset.t }); commit('manual'); toast('같은 거래로 합쳤습니다'); },
  // 계산서에 거래 연결: 거래에서 아직 안 나눠준 금액만큼, 계산서 잔액까지만 배분 (기존 연결은 유지하고 추가)
  invLink: el => {
    const M = model();
    const i = S().invoices[el.dataset.inv];
    const t = M.txById.get(el.dataset.t);
    const s = M.inv.st[i.id];
    const amt = Math.min(M.inv.leftOf(t, i.kind), s.remain || s.eff);
    if (!(amt > 0)) { toast('이 거래는 이미 다른 계산서에 전부 배분되었습니다'); return; }
    patch('invoices', i.id, { links: [...linksOf(i), { t: t.id, amt }], linkTxns: [], settled: false });
    const n = M.info.get(t.id).n;
    if (n) put('aliases', { id: n, biz: i.biz, name: i.name });
    commit('inv');
    toast(amt < (s.remain || s.eff) ? `일부 ${won(amt)}원 연결. 잔액 ${won((s.remain || s.eff) - amt)}원은 남아 있습니다` : '연결했습니다. 다음부터 이 이름은 자동으로 이 거래처로 봅니다');
  },
  grpLink: el => {
    const M = model();
    const t = M.txById.get(el.dataset.t);
    const ids = el.dataset.ids.split(',').map(id => S().invoices[id]).sort((a, b) => (a.wdate < b.wdate ? -1 : 1));
    let have = M.inv.leftOf(t, ids[0].kind);
    for (const i of ids) {
      const amt = Math.min(have, M.inv.st[i.id].remain || M.inv.st[i.id].eff);
      if (amt <= 0) break;
      have -= amt;
      patch('invoices', i.id, { links: [...linksOf(i), { t: t.id, amt }], linkTxns: [], settled: false });
    }
    commit('inv'); toast('계산서와 연결했습니다');
  },
  xferYes: el => { put('decisions', { id: 'xferYes:' + el.dataset.t, v: 'yes' }); commit('review'); toast('내 통장 이체로 표시했습니다 (매출·비용에서 빠짐)'); },
  invSettle: el => { patch('invoices', el.dataset.id, { settled: true }); commit('inv'); },
  invReset: el => { patch('invoices', el.dataset.id, { settled: false, linkTxns: [], links: [], noAuto: false }); commit('inv'); },
  // 일부 지급·수금 입력 (은행 자료 전, 사용자 입력)
  occPart: el => {
    const o = occByKey(el.dataset.key);
    if (!o) return;
    const v = prompt(`${o.title}\n지금까지 ${o.kind === 'in' ? '받은' : '보낸'} 금액 (전체 ${won(o.amount)}원)`, o.paid ? won(o.paid) : '');
    if (v === null) return;
    const n = parseWonInput(v || '0');
    if (Number.isNaN(n) || n > o.amount) { toast('0 ~ 전체 금액 사이 숫자로 넣어주세요'); return; }
    if (o.src === 'rec') put('plans', { ...recRow(o), partPaid: n, done: false });
    else patch('plans', o.planId, { partPaid: n });
    commit('plan'); toast(n ? `일부 ${won(n)}원 · 잔액 ${won(o.amount - n)}원` : '일부 금액을 지웠습니다');
  },
  invNoAuto: el => { patch('invoices', el.dataset.id, { noAuto: true }); commit('inv'); toast('자동 연결을 풀었습니다. 검토 화면에서 맞는 거래로 직접 연결하세요'); },
  invKind: el => { ui.inv.kind = el.dataset.k; render(); },
  invPlan: el => {
    const M = model();
    const i = S().invoices[el.dataset.id];
    const d = document.getElementById('ivd-' + i.id)?.value || todayStr();
    put('plans', { id: uid('p'), date: d, kind: i.kind === 'sales' ? 'in' : 'out', amount: M.inv.st[i.id].eff, title: `${i.name}${i.note ? ' · ' + i.note : ''}`.slice(0, 80), acct: '', cat: 'invoice', invoiceId: i.id, personal: false, done: false });
    commit('plan'); toast('계획에 넣었습니다');
  },
  planDays: el => { ui.plan.days = +el.dataset.d; render(); },
  planAdd: () => {
    const v = id => document.getElementById(id);
    const amount = parseWonInput(v('pl-amt').value);
    const title = v('pl-title').value.trim();
    if (!(amount > 0)) { toast('금액을 숫자로 넣어주세요'); return; }
    if (!title) { toast('내용을 넣어주세요'); return; }
    const [kind, sub] = v('pl-kind').value.split(':');
    const date = v('pl-date').value || '';
    put('plans', { id: uid('p'), date, kind, pay: kind === 'out' ? sub : '', conf: kind === 'in' ? sub : '', amount, title, acct: v('pl-acct').value, cat: 'etc', personal: v('pl-personal').checked, done: false });
    commit('plan'); toast(date ? '추가했습니다' : '날짜 미정으로 추가했습니다 (확인 필요 목록에 보임)');
  },
  planDel: el => { if (confirm('이 예정 항목을 삭제할까요?')) { remove('plans', el.dataset.id); commit('plan'); } },
  planConf: el => { const o = occByKey(el.dataset.key); if (!o) return; patch('plans', o.planId, { conf: o.conf === 'confirmed' ? 'expected' : 'confirmed' }); commit('plan'); },
  occSkip: el => { const o = occByKey(el.dataset.key); if (o && confirm(`${o.title} - 이번 달만 건너뛸까요?`)) { put('plans', { ...recRow(o), skipped: true, done: true }); commit('plan'); } },
  // 휴일 등으로 이번 달 날짜·금액만 바꾸기 (다음 달 예상액은 그대로)
  occEdit: el => {
    const o = occByKey(el.dataset.key);
    if (!o) return;
    const d = prompt(`${o.title}\n이번 달 날짜 (예: ${o.date})`, o.date);
    if (d === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) { toast('날짜는 2026-11-16 처럼 넣어주세요'); return; }
    const a = prompt('이번 달 금액 (실제 지급할 금액)', won(o.amount));
    if (a === null) return;
    const amount = parseWonInput(a);
    if (!(amount > 0)) { toast('금액을 숫자로 넣어주세요'); return; }
    if (o.src === 'rec') put('plans', { ...recRow(o), date: d.trim(), amount, done: false });
    else patch('plans', o.planId, { date: d.trim(), amount });
    commit('plan'); toast('이번 달만 바꿨습니다. 다음 달은 원래 예상액으로 나옵니다');
  },
  occReset: el => { const o = occByKey(el.dataset.key); if (o && confirm('이번 달 바꾼 내용을 지우고 원래 예상값으로 되돌릴까요?')) { remove('plans', o.planId); commit('plan'); } },
  range: el => { ui.home.range = el.dataset.k; render(); },
  cardSel: el => { const s = ui.cards.sel; ui.cards.sel = s && s.acct === el.dataset.a && s.ym === el.dataset.m ? null : { acct: el.dataset.a, ym: el.dataset.m }; render(); },
  recAdd: () => {
    const v = id => document.getElementById(id);
    const amount = parseWonInput(v('rc-amt').value), day = parseInt(v('rc-day').value, 10), title = v('rc-title').value.trim();
    if (!title || !(amount > 0) || !(day >= 1 && day <= 31)) { toast('내용, 날짜(1~31), 금액을 모두 넣어주세요'); return; }
    const kind = v('rc-kind').value;
    put('recurring', { id: uid('r'), title, day, amount, kind, pay: kind === 'out' ? v('rc-pay').value : '', bankName: v('rc-bank').value.trim(), acct: v('rc-acct').value, personal: v('rc-personal').checked, active: true, cat: 'fixed', startYm: ymOf(todayStr()) });
    commit('rec'); toast('고정 지출을 추가했습니다');
  },
  recAddSug: el => {
    const r = ui.recSugg[+el.dataset.i];
    put('recurring', { id: uid('r'), title: r.title, day: r.day, amount: r.amount, kind: 'out', pay: r.pay, bankName: r.bankName, acct: r.acct, personal: false, active: true, cat: 'fixed', startYm: ymOf(todayStr()) });
    commit('rec'); toast('추가했습니다. 금액·날짜를 확인해 주세요');
  },
  recDel: el => { if (confirm('이 고정 지출을 삭제할까요?')) { remove('recurring', el.dataset.id); commit('rec'); } },
  exportJson: () => download(`에스튜브경리-백업-${todayStr()}.json`, new Blob([JSON.stringify(S(), null, 1)], { type: 'application/json' })),
  exportXlsx: () => {
    const M = model();
    const wb = XLSX.utils.book_new();
    const tx = M.txns.map(t => ({ 일자: t.date, 시간: t.time, 통장: acctName(M, t.acct), 내용: t.desc, 방법: t.method, 입금: t.in, 출금: t.out, 잔액: t.bal, 개인: t.personal ? 'Y' : '', 메모: t.note || '' }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tx), '통합장부');
    const iv = M.inv.list.map(i => ({ 구분: i.kind === 'sales' ? '매출' : '매입', 작성일자: i.wdate, 승인번호: i.id, 거래처: i.name, 사업자번호: i.biz, 공급가액: i.supply, 세액: i.tax, 합계: i.total, 상태: M.inv.st[i.id].state, 비고: i.note }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(iv), '세금계산서');
    XLSX.writeFile(wb, `에스튜브-장부-${todayStr()}.xlsx`);
  },
  resetLocal: () => {
    if (!confirm('이 기기에 저장된 장부를 지울까요? 구글 드라이브 자료는 그대로입니다.')) return;
    replaceState(emptyState(), 'reset');
    store.dirty = false;
    try { localStorage.removeItem('stube-ledger-sync' + NS); } catch { /* 무시 */ }
    toast('이 기기 자료를 지웠습니다');
  },
  np: el => {
    const k = el.dataset.k;
    let s = ui.add.amount || '';
    if (k === '←') s = s.slice(0, -1);
    else if (s.length < 12) s = (s + k).replace(/^0+/, '');
    ui.add.amount = s;
    render();
  },
  addAcct: el => { ui.add.acct = el.dataset.a; render(); },
  addSave: () => {
    const a = ui.add;
    const amount = parseWonInput(a.amount || '');
    if (!(amount > 0)) { toast('금액을 눌러주세요'); return; }
    if (!a.acct) { toast('통장을 골라주세요'); return; }
    put('manual', { id: uid('m'), acct: a.acct, date: a.date || todayStr(), amount, memo: (a.memo || '').trim(), personal: !!a.personal, linkTxn: '' });
    ui.add = { amount: '', acct: a.acct, memo: '', date: '', personal: false };
    location.hash = '#m';
    commit('manual');
    toast(`${won(amount)}원 기록했습니다`);
  },
};

let qTimer;
const INP = {
  lq: el => { ui.ledger.q = el.value; ui.ledger.limit = 300; clearTimeout(qTimer); qTimer = setTimeout(render, 250); },
  pq: el => { ui.partners.q = el.value; clearTimeout(qTimer); qTimer = setTimeout(render, 250); },
  addMemo: el => { ui.add.memo = el.value; },
};

const CHG = {
  files: el => { readFiles([...el.files]); el.value = ''; },
  impAcct: el => { ui.imports[+el.dataset.i].acct = el.value; render(); },
  lf: el => { ui.ledger[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; ui.ledger.limit = 300; render(); },
  showDismissed: el => { ui.review.showDismissed = el.checked; render(); },
  occDone: el => { const o = occByKey(el.dataset.key); if (o) setOccDone(o, el.checked); },
  minBal: el => { const n = parseWonInput(el.value || '0'); if (Number.isNaN(n)) { toast('숫자로 넣어주세요'); render(); return; } setSettings({ minBalance: n }); commit('settings'); },
  inclPersonal: el => { setSettings({ includePersonal: el.checked }); commit('settings'); },
  invPeriod: el => { ui.inv.period = el.value; render(); },
  invStatus: el => { ui.inv.status = el.value; render(); },
  vatPrepaid: el => { const n = parseWonInput(el.value || '0'); if (Number.isNaN(n)) { toast('숫자로 넣어주세요'); return; } setSettings({ vatPrepaid: { ...(S().settings.vatPrepaid || {}), [el.dataset.k]: n } }); commit('settings'); },
  recField: el => {
    const f = el.dataset.f;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (f === 'amount') { v = parseWonInput(v); if (!(v > 0)) { toast('금액을 숫자로 넣어주세요'); render(); return; } }
    if (f === 'day') { v = parseInt(v, 10); if (!(v >= 1 && v <= 31)) { toast('1~31 사이로 넣어주세요'); render(); return; } }
    if (f === 'bankName' || f === 'title') v = String(v).trim();
    patch('recurring', el.dataset.id, { [f]: v }); commit('rec');
  },
  acctField: el => { patch('accounts', el.dataset.id, { [el.dataset.f]: el.value.trim() }); commit('acct'); },
  cycleDays: el => { const n = parseInt(el.value, 10); if (n >= 1 && n <= 60) { setSettings({ cycleDays: n }); commit('settings'); } },
  importJson: async el => {
    const f = el.files[0]; el.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !data.txns) throw new Error('형식이 다릅니다');
      const { state } = merge(S(), data);
      replaceState(state, 'restore');
      commit('restore');
      toast('백업 파일과 합쳤습니다');
    } catch (e) { toast('백업 파일을 읽지 못했습니다: ' + e.message); }
  },
  aliasSet: el => {
    if (!el.value) return;
    const p = partners(model()).find(x => x.biz === el.value);
    put('aliases', { id: el.dataset.n, biz: el.value, name: p ? p.name : '' });
    commit('alias'); toast('이 입금자 이름을 거래처와 연결했습니다. 계산서와 다시 맞춰봅니다');
  },
  addDate: el => { ui.add.date = el.value; },
  addPersonal: el => { ui.add.personal = el.checked; },
};

extendUI({ ACT, CHG, INP });

export function initUI() {
  const root = document.getElementById('app');
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const f = ACT[el.dataset.act];
    if (f) { e.preventDefault(); f(el, e); }
  });
  root.addEventListener('change', e => { const el = e.target.closest('[data-chg]'); if (el && CHG[el.dataset.chg]) CHG[el.dataset.chg](el, e); });
  root.addEventListener('input', e => { const el = e.target.closest('[data-inp]'); if (el && INP[el.dataset.inp]) INP[el.dataset.inp](el, e); });
  root.addEventListener('dragover', e => { if (e.target.closest('.drop')) { e.preventDefault(); e.target.closest('.drop').classList.add('over'); } });
  root.addEventListener('dragleave', e => { const z = e.target.closest('.drop'); if (z) z.classList.remove('over'); });
  root.addEventListener('drop', e => { const z = e.target.closest('.drop'); if (!z) return; e.preventDefault(); z.classList.remove('over'); readFiles([...e.dataTransfer.files]); });
}

// 개발 중 확인용
export const debug = { ui, readFiles, model };
