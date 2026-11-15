// 화면: 핸드폰 "지출·증빙 기록", PC "작업·원가"
import { store, put, patch, remove, commit, live } from './store.js';
import { model } from './engine.js';
import { esc, won, todayStr, addDays, parseWonInput, fmtMD, uid, nowTs } from './util.js';
import { CAT, EVK, partyList, ensureParty, newParty, siteList, newSite, jobList, newJob, jobLabel, costBase, paidOf, reconOf, costUsing, dupCosts, similarCosts, costModel, itemSummary, searchJobs, newCostId } from './jobs.js';
import { addEvidence, evidenceUrl } from './evidence.js';
import { render, toast } from './views.js';

const S = () => store.state;
const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;
const blankAdd = (keep = {}) => ({ mode: 'new', amount: '', acct: keep.acct || '', pay: 'paid', cat: keep.cat || 'expense', partyId: keep.partyId || '', siteId: keep.siteId || '', jobId: keep.jobId || '', vendor: '', note: '', date: '', personal: false, supply: '', vat: '', items: [], files: [], kind: 'receipt', attachTo: '', showTax: false, showItems: false });
export const jui = { add: blankAdd(), jobs: { q: '', from: '', to: '', sel: '' }, busy: false };

const itemAmt = it => { const q = Number(it.qty), p = parseWonInput(it.price || ''); return Number.isFinite(q) && p >= 0 ? Math.round(q * p) : 0; };
const evOf = costId => live('evid').filter(e => e.costId === costId);
const evBtn = c => { const n = evOf(c.id).length; return n ? `<button class="sm ghost" data-act="evShow" data-cost="${c.id}">📎 ${n}</button>` : ''; };
const reconTag = (M, c) => { const r = reconOf(M, c); return tag(r.label, { bank: 'green', inv: 'green', part: 'amber', unpaid: 'red', user: 'blue' }[r.k]); };
const costTitle = c => esc(c.vendor || c.note || CAT[c.cat] || '비용');

function partySel(M, a, act) {
  return `<select data-chg="${act}" data-lvl="party"><option value="">미분류 (나중에 PC에서 정리)</option>${partyList(M).map(p => `<option value="${p.id}" ${p.id === a.partyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ 새 거래처</option></select>
  ${a.partyId ? `<select data-chg="${act}" data-lvl="site"><option value="">현장 미정</option>${siteList(a.partyId).map(s => `<option value="${s.id}" ${s.id === a.siteId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__new">+ 새 현장</option></select>` : ''}
  ${a.siteId ? `<select data-chg="${act}" data-lvl="job"><option value="">작업 미정</option>${jobList(a.siteId).map(j => `<option value="${j.id}" ${j.id === a.jobId ? 'selected' : ''}>${esc(j.name)}${j.po ? ' (PO ' + esc(j.po) + ')' : ''}</option>`).join('')}<option value="__new">+ 새 작업</option></select>` : ''}`;
}

function photoBlock(a) {
  return `<div class="lbl">증빙 사진 <span class="muted">(영수증·이체 캡처 둘 다 올려도 비용은 한 번만)</span></div>
    <div class="pills">${Object.entries(EVK).map(([k, l]) => `<button class="pill ${a.kind === k ? 'on' : ''}" data-act="caKind" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="photos">
      <label class="pbtn">📷 촬영<input type="file" accept="image/*" capture="environment" data-chg="caFiles" hidden></label>
      <label class="pbtn">🖼 갤러리<input type="file" accept="image/*,application/pdf" multiple data-chg="caFiles" hidden></label>
    </div>
    ${a.files.length ? `<div class="thumbs">${a.files.map((f, i) => `<span class="thumb">${f.url ? `<img src="${f.url}" alt="">` : '📄'}<small>${EVK[f.kind]}</small><button type="button" data-act="caRm" data-i="${i}" aria-label="빼기">×</button></span>`).join('')}</div>` : ''}`;
}

// ───── 핸드폰: 지출·증빙 기록 ─────
export function costAddView(M) {
  const a = jui.add;
  if (!a.acct && M.accounts.length) a.acct = M.accounts[0].id;
  if (!a.date) a.date = todayStr();
  const tabs = `<div class="pills seg"><button class="pill ${a.mode === 'new' ? 'on' : ''}" data-act="caMode" data-m="new">새 비용</button><button class="pill ${a.mode === 'attach' ? 'on' : ''}" data-act="caMode" data-m="attach">기존 비용에 증빙만 붙이기</button></div>`;
  if (a.mode === 'attach') {
    const since = addDays(todayStr(), -60);
    const costs = live('costs').filter(c => c.date >= since).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 30);
    const txs = M.txns.filter(t => t.out > 0 && t.date >= addDays(todayStr(), -40) && !M.info.get(t.id).card && !costUsing(M, { txnId: t.id })).slice(-30).reverse();
    const row = (val, d, title, amount, extra) => `<label class="mrow"><input type="radio" name="attach" value="${val}" data-chg="caAttachTo" ${a.attachTo === val ? 'checked' : ''}><span class="d">${fmtMD(d)}</span><span class="t">${title}${extra || ''}</span><span class="num out">-${won(amount)}</span></label>`;
    return `<section class="mcard add">${tabs}
      <div class="lbl">어느 비용에 붙일까요?</div>
      ${costs.length ? costs.map(c => row('c:' + c.id, c.date, costTitle(c), c.total, ` ${tag(CAT[c.cat] || '')}${evOf(c.id).length ? ' 📎' + evOf(c.id).length : ''}`)).join('') : '<div class="muted">최근 등록한 비용이 없습니다.</div>'}
      ${txs.length ? `<div class="lbl">통장 출금 (아직 원가 아님 → 붙이면 원가로 등록)</div>${txs.map(t => row('t:' + t.id, t.date, esc(t.desc), t.out, '')).join('')}` : ''}
      ${photoBlock(a)}
      <div class="row2"><a class="mbtn ghost" href="#m">취소</a><button class="mbtn" data-act="caAttach" ${jui.busy ? 'disabled' : ''}>증빙 붙이기</button></div></section>`;
  }
  const n = parseWonInput(a.amount || '0');
  return `<section class="mcard add">${tabs}
    <div class="amtdisp">${a.amount ? won(n) : '0'}<span>원</span></div>
    <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '←'].map(k => `<button data-act="caNp" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="lbl">어디서 나갔나요?</div>
    <div class="pills">${M.accounts.map(x => `<button class="pill ${a.pay === 'paid' && x.id === a.acct ? 'on' : ''}" data-act="caAcct" data-a="${x.id}">${esc(x.name)}</button>`).join('')}<button class="pill ${a.pay === 'unpaid' ? 'on' : ''}" data-act="caAcct" data-a="__unpaid">아직 안 냄 (외상)</button></div>
    <div class="lbl">분류</div>
    <div class="pills">${Object.entries(CAT).map(([k, l]) => `<button class="pill ${a.cat === k ? 'on' : ''}" data-act="caCat" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="lbl">거래처 → 현장 → 작업</div>
    <div class="stack">${partySel(M, a, 'caSel')}</div>
    <input type="text" id="ca-vendor" placeholder="지급처 (가게·사람 이름)" value="${esc(a.vendor)}" data-inp="caF" data-f="vendor">
    <textarea id="ca-note" rows="2" placeholder="비고 (예: 센서용 스터드 2개 추가 구매)" data-inp="caF" data-f="note">${esc(a.note)}</textarea>
    ${photoBlock(a)}
    <div class="fold"><button type="button" class="link" data-act="caTog" data-k="showTax">${a.showTax ? '▾' : '▸'} 공급가·부가세 나누기 (영수증·계산서에 적혀 있을 때만)</button>
      ${a.showTax ? `<div class="row2"><input type="text" id="ca-supply" inputmode="numeric" placeholder="공급가" value="${esc(a.supply)}" data-inp="caF" data-f="supply"><input type="text" id="ca-vat" inputmode="numeric" placeholder="부가세" value="${esc(a.vat)}" data-inp="caF" data-f="vat"></div><div class="hint">안 보이거나 모르면 비워두세요. 짐작해서 넣지 않습니다 → "부가세 구분 안 됨"으로 저장.</div>` : ''}</div>
    <div class="fold"><button type="button" class="link" data-act="caTog" data-k="showItems">${a.showItems ? '▾' : '▸'} 자재 품목 적기 (품명·수량·단가)${a.items.length ? ` · ${a.items.length}개` : ''}</button>
      ${a.showItems ? `${a.items.map((it, i) => `<div class="item"><input type="text" id="it-n-${i}" placeholder="품명" value="${esc(it.name)}" data-inp="caItem" data-i="${i}" data-f="name"><input type="text" id="it-q-${i}" class="w4" inputmode="decimal" placeholder="수량" value="${esc(it.qty)}" data-inp="caItem" data-chg="caItemDone" data-i="${i}" data-f="qty"><input type="text" id="it-u-${i}" class="w4" placeholder="단위" value="${esc(it.unit)}" data-inp="caItem" data-i="${i}" data-f="unit"><input type="text" id="it-p-${i}" inputmode="numeric" placeholder="단가" value="${esc(it.price)}" data-inp="caItem" data-chg="caItemDone" data-i="${i}" data-f="price"><span class="num">${won(itemAmt(it))}</span><button type="button" class="sm ghost" data-act="caItemRm" data-i="${i}">×</button></div>`).join('')}
        <button type="button" class="sm" data-act="caItemAdd">+ 품목</button>${a.items.length ? `<div class="hint">품목 합계 ${won(a.items.reduce((s, it) => s + itemAmt(it), 0))}원</div>` : ''}` : ''}</div>
    <div class="row2"><input type="date" id="ca-date" value="${a.date}" data-chg="caDate"><label class="chk"><input type="checkbox" data-chg="caPersonal" ${a.personal ? 'checked' : ''}> 개인 지출</label></div>
    <div class="row2"><a class="mbtn ghost" href="#m">취소</a><button class="mbtn" data-act="caSave" ${jui.busy ? 'disabled' : ''}>저장</button></div>
  </section>`;
}

// ───── PC: 작업·원가 ─────
export function jobsView(M) {
  const st = jui.jobs;
  const CM = costModel(M, { from: st.from, to: st.to });
  const { jobs, loose } = searchJobs(M, CM, st.q);
  const dups = dupCosts(M);
  const allJobs = live('jobs').sort((a, b) => jobLabel(a).localeCompare(jobLabel(b), 'ko'));
  const sum = (arr, f) => arr.reduce((s, r) => s + f(r), 0);
  const sel = st.sel && CM.byJob.get(st.sel);
  const jobOpts = (cur = '') => `<option value="">작업 고르기</option>${allJobs.map(j => `<option value="${j.id}" ${j.id === cur ? 'selected' : ''}>${esc(jobLabel(j))}</option>`).join('')}`;
  return `
  <h1>작업·원가</h1>
  <div class="filters">
    <input type="search" id="jq" placeholder="검색: 거래처·현장·작업·PO·비고·품명 (예: 목동 진동센서)" value="${esc(st.q)}" data-inp="jq" style="min-width:320px">
    <label class="inl">기간 <input type="date" value="${st.from}" data-chg="jPer" data-f="from"> ~ <input type="date" value="${st.to}" data-chg="jPer" data-f="to"></label>
  </div>
  ${dups.length ? `<section class="card"><div class="errline">같은 돈이 원가에 두 번 잡혀 있습니다 (${dups.length}건). 하나를 지워주세요.</div>
    ${dups.map(([x, y]) => `<div class="ri">${[x, y].map(c => `<div class="txline"><span class="d">${fmtMD(c.date)}</span><span class="t">${costTitle(c)} ${tag(c.src === 'phone' ? '핸드폰' : c.src === 'bank' ? '통장' : c.src === 'invoice' ? '계산서' : 'PC')}</span><span class="num">${won(c.total)}</span><button class="sm ghost" data-act="costDel" data-id="${c.id}">이 비용 지우기</button></div>`).join('')}</div>`).join('')}</section>` : ''}
  <section class="card"><div class="row-h"><h2>작업 ${jobs.length}건</h2><span class="muted">원가 = 공급가 기준 (공급가를 모르면 합계) · 지급/미지급 = 실제 돈(합계) 기준</span></div>
    ${jobs.length ? `<table class="tbl"><thead><tr><th>작업</th><th class="r">자재</th><th class="r">인건비</th><th class="r">경비</th><th class="r">외주비</th><th class="r">총원가</th><th class="r">부가세</th><th class="r">합계</th><th class="r">지급</th><th class="r">미지급</th></tr></thead><tbody>
    ${jobs.map(r => `<tr class="${st.sel === r.job.id ? 'on' : ''}"><td><button class="link" data-act="jobSel" data-id="${r.job.id}">${esc(jobLabel(r.job))}</button>${r.noVat ? ' ' + tag('부가세 구분 안 된 비용 포함', 'gray') : ''}</td>
      <td class="r">${won(r.cat.material)}</td><td class="r">${won(r.cat.labor)}</td><td class="r">${won(r.cat.expense)}</td><td class="r">${won(r.cat.outsource)}</td><td class="r"><b>${won(r.base)}</b></td><td class="r muted">${won(r.vat)}</td><td class="r">${won(r.total)}</td><td class="r">${won(r.paid)}</td><td class="r">${r.unpaid ? `<b class="red">${won(r.unpaid)}</b>` : '0'}</td></tr>`).join('')}
    <tr class="sub"><td>합계</td><td class="r">${won(sum(jobs, r => r.cat.material))}</td><td class="r">${won(sum(jobs, r => r.cat.labor))}</td><td class="r">${won(sum(jobs, r => r.cat.expense))}</td><td class="r">${won(sum(jobs, r => r.cat.outsource))}</td><td class="r">${won(sum(jobs, r => r.base))}</td><td class="r">${won(sum(jobs, r => r.vat))}</td><td class="r">${won(sum(jobs, r => r.total))}</td><td class="r">${won(sum(jobs, r => r.paid))}</td><td class="r">${won(sum(jobs, r => r.unpaid))}</td></tr>
    </tbody></table>` : '<div class="muted">찾는 작업이 없습니다.</div>'}
  </section>
  ${sel ? jobDetail(M, sel) : ''}
  <section class="card"><h2>미분류·배분 안 된 비용 ${CM.unalloc.length}건</h2>
    <div class="hint">작업이 정해지지 않았거나 일부만 나눈 비용입니다. 여러 작업에 걸치면 금액을 나눠 여러 번 배분하세요 (전체 합계에는 한 번만 잡힘).</div>
    ${(st.q ? loose : CM.unalloc).length ? `<table class="tbl"><thead><tr><th>날짜</th><th>분류</th><th>내용</th><th class="r">원가</th><th class="r">남은 금액</th><th>상태</th><th>배분</th></tr></thead><tbody>
    ${(st.q ? loose : CM.unalloc).slice(0, 100).map(({ c, left }) => `<tr><td class="nowrap">${fmtMD(c.date)}</td>
      <td><select data-chg="costCat" data-id="${c.id}">${Object.entries(CAT).map(([k, l]) => `<option value="${k}" ${c.cat === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${costTitle(c)}${c.note && c.vendor ? `<div class="hint">${esc(c.note)}</div>` : ''}${(c.items || []).length ? `<div class="hint">품목: ${esc(c.items.map(i => `${i.name} ${i.qty}${i.unit}`).join(', '))}</div>` : ''} ${evBtn(c)}</td>
      <td class="r">${won(costBase(c))}${c.supply == null ? '<div class="muted s">부가세 구분 안 됨</div>' : ''}</td><td class="r"><b>${won(left)}</b></td><td>${reconTag(M, c)}${c.pay === 'unpaid' && !c.invoiceId ? ` <button class="sm" data-act="costPaid" data-id="${c.id}">지급함</button>` : ''}</td>
      <td class="nowrap"><select id="al-j-${c.id}">${jobOpts()}</select> <input type="text" id="al-a-${c.id}" class="w8 r" inputmode="numeric" value="${won(left)}"> <button class="sm primary" data-act="costAlloc" data-id="${c.id}">배분</button> <button class="sm ghost" data-act="costDel" data-id="${c.id}">삭제</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="muted">없습니다.</div>'}
  </section>
  <section class="card"><h2>새 작업 만들기</h2>
    <div class="form">${partySel(M, jui.newJob || (jui.newJob = { partyId: '', siteId: '', jobId: '' }), 'njSel')}
      <input type="text" id="nj-name" placeholder="작업명 (예: 진동센서 교체)"><input type="text" id="nj-po" placeholder="PO 번호 (선택)" class="w8"><input type="text" id="nj-line" placeholder="라인" class="w4">
      <button class="primary" data-act="jobAdd">작업 추가</button></div>
    <div class="hint">거래처 → 현장을 먼저 고르거나 새로 만든 뒤 작업명을 넣으세요. 통장 출금·매입 계산서도 "통합 장부"·"세금계산서" 화면의 "원가" 버튼으로 여기 올릴 수 있습니다.</div>
  </section>`;
}

function jobDetail(M, r) {
  const j = r.job;
  const items = itemSummary(r.items);
  return `<section class="card"><div class="row-h"><h2>${esc(jobLabel(j))}</h2><button class="sm ghost" data-act="jobSel" data-id="">닫기</button></div>
    <div class="grid5">
      <div class="mc"><div class="l">총원가 (공급가 기준)</div><div class="v">${won(r.base)}</div></div>
      <div class="mc"><div class="l">부가세</div><div class="v">${won(r.vat)}</div>${r.noVat ? `<div class="s">구분 안 된 비용 ${won(r.noVat)}</div>` : ''}</div>
      <div class="mc"><div class="l">합계 (실제 돈)</div><div class="v">${won(r.total)}</div></div>
      <div class="mc"><div class="l">지급</div><div class="v">${won(r.paid)}</div></div>
      <div class="mc ${r.unpaid ? 'bad' : ''}"><div class="l">미지급</div><div class="v">${won(r.unpaid)}</div></div>
    </div>
    <table class="tbl"><thead><tr><th>날짜</th><th>분류</th><th>내용</th><th class="r">원가 배분</th><th class="r">합계 몫</th><th class="r">지급</th><th>상태</th><th></th></tr></thead><tbody>
    ${r.lines.sort((a, b) => (a.c.date < b.c.date ? -1 : 1)).map(l => `<tr><td class="nowrap">${fmtMD(l.c.date)}</td><td>${CAT[l.c.cat] || ''}</td><td>${costTitle(l.c)}${l.c.note && l.c.vendor ? `<div class="hint">${esc(l.c.note)}</div>` : ''} ${evBtn(l.c)}</td><td class="r">${won(l.amount)}${l.amount < costBase(l.c) ? `<div class="muted s">전체 ${won(costBase(l.c))} 중</div>` : ''}</td><td class="r">${won(l.total)}</td><td class="r">${won(l.paid)}</td><td>${reconTag(M, l.c)}${l.c.pay === 'unpaid' && !l.c.invoiceId ? ` <button class="sm" data-act="costPaid" data-id="${l.c.id}">지급함</button>` : ''}</td><td class="act"><button class="sm ghost" data-act="allocDel" data-id="${l.c.id}" data-job="${j.id}">배분 풀기</button></td></tr>`).join('')}
    </tbody></table>
    ${items.length ? `<h3>자재 품목</h3><table class="tbl"><thead><tr><th>품명</th><th class="r">수량</th><th>단위</th><th class="r">금액</th><th class="r">건수</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.name)}</td><td class="r">${i.qty}</td><td>${esc(i.unit)}</td><td class="r">${won(i.amount)}</td><td class="r">${i.n}</td></tr>`).join('')}</tbody></table>` : ''}
  </section>`;
}

// 사진 보기 (로그인한 본인만: 드라이브에서 받아서 이 화면에만 표시)
async function showEvidence(costId) {
  const evs = evOf(costId);
  const box = document.createElement('div');
  box.id = 'evmodal';
  box.innerHTML = `<div class="evbox"><div class="row-h"><b>증빙 ${evs.length}장</b><button class="sm" id="evclose">닫기</button></div><div class="evimgs">불러오는 중…</div></div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.addEventListener('click', e => { if (e.target === box || e.target.id === 'evclose') close(); });
  const parts = [];
  for (const ev of evs) {
    try { const u = await evidenceUrl(ev); parts.push(ev.mime === 'application/pdf' ? `<a href="${u}" target="_blank" rel="noopener">${EVK[ev.kind] || ''} PDF 열기</a>` : `<figure><img src="${u}" alt=""><figcaption>${EVK[ev.kind] || ''} · ${esc(ev.at)}</figcaption></figure>`); }
    catch (e) { parts.push(`<div class="errline">${EVK[ev.kind] || ''}: ${esc(e.message === 'NEED_LOGIN' ? '구글 드라이브 연결이 필요합니다' : e.message)}</div>`); }
  }
  box.querySelector('.evimgs').innerHTML = parts.join('');
}

function pickHier(M, a, el) {
  const lvl = el.dataset.lvl, v = el.value;
  if (lvl === 'party') {
    if (v === '__new') { const n = prompt('새 거래처 이름'); if (!n || !n.trim()) { render(); return false; } a.partyId = newParty(n).id; commit('party'); }
    else { a.partyId = v; if (v) ensureParty(M, v); }
    a.siteId = ''; a.jobId = '';
  } else if (lvl === 'site') {
    if (v === '__new') { const n = prompt('새 현장 이름 (예: 목동)'); if (!n || !n.trim()) { render(); return false; } a.siteId = newSite(a.partyId, n).id; commit('site'); }
    else a.siteId = v;
    a.jobId = '';
  } else if (lvl === 'job') {
    if (v === '__new') {
      const n = prompt('새 작업명 (예: 진동센서 교체)'); if (!n || !n.trim()) { render(); return false; }
      const po = prompt('PO 번호 (없으면 비워두세요)', '') || '';
      a.jobId = newJob(a.partyId, a.siteId, n, po).id; commit('job');
    } else a.jobId = v;
  }
  return true;
}

// ───── 동작 연결 ─────
export function extendUI({ ACT, CHG, INP }) {
  const A = () => jui.add;
  Object.assign(ACT, {
    caMode: el => { A().mode = el.dataset.m; render(); },
    mAdd: el => { A().mode = el.dataset.m; if (location.hash === '#m-add') render(); else location.hash = '#m-add'; },
    caNp: el => { const k = el.dataset.k; let s = A().amount || ''; if (k === '←') s = s.slice(0, -1); else if (s.length < 12) s = (s + k).replace(/^0+/, ''); A().amount = s; render(); },
    caAcct: el => { if (el.dataset.a === '__unpaid') A().pay = 'unpaid'; else { A().pay = 'paid'; A().acct = el.dataset.a; } render(); },
    caCat: el => { A().cat = el.dataset.k; render(); },
    caKind: el => { A().kind = el.dataset.k; render(); },
    caTog: el => { A()[el.dataset.k] = !A()[el.dataset.k]; if (el.dataset.k === 'showItems' && A().showItems && !A().items.length) A().items.push({ name: '', qty: '', unit: '', price: '' }); render(); },
    caItemAdd: () => { A().items.push({ name: '', qty: '', unit: '', price: '' }); render(); },
    caItemRm: el => { A().items.splice(+el.dataset.i, 1); render(); },
    caRm: el => { const f = A().files.splice(+el.dataset.i, 1)[0]; if (f && f.url) URL.revokeObjectURL(f.url); render(); },
    caSave: async () => {
      const a = A(), M = model();
      const total = parseWonInput(a.amount || '');
      if (!(total > 0)) { toast('금액을 눌러주세요'); return; }
      let supply = null, vat = null;
      if (String(a.supply).trim() !== '' || String(a.vat).trim() !== '') {
        supply = parseWonInput(a.supply); vat = parseWonInput(a.vat);
        if (Number.isNaN(supply) || Number.isNaN(vat)) { toast('공급가·부가세는 둘 다 숫자로 넣거나 둘 다 비워두세요'); return; }
        if (supply + vat !== total) { toast(`공급가 ${won(supply)} + 부가세 ${won(vat)} = ${won(supply + vat)}원이 금액 ${won(total)}원과 다릅니다`); return; }
      }
      const items = a.items.filter(i => i.name || i.qty || i.price).map(i => ({ name: String(i.name).trim(), qty: Number(i.qty) || 0, unit: String(i.unit).trim(), price: parseWonInput(i.price || '0') || 0, amount: itemAmt(i) }));
      if (items.some(i => !i.name)) { toast('품목의 품명을 넣어주세요'); return; }
      if (a.pay === 'paid' && !a.acct) { toast('어느 통장에서 나갔는지 골라주세요'); return; }
      const date = a.date || todayStr();
      jui.busy = true;
      try {
        // 같은 금액·비슷한 날짜 비용이 이미 있으면: 새로 만들지, 그 비용에 사진만 붙일지 묻기 (돈은 한 번만)
        const sim = similarCosts(total, date);
        if (sim.length && !confirm(`${fmtMD(sim[0].date)} ${sim[0].vendor || sim[0].note || ''} ${won(total)}원 비용이 이미 있습니다.\n\n[확인] 다른 비용이 맞음 → 새로 등록\n[취소] 같은 비용임 → 그 비용에 사진만 붙이기 (돈은 한 번만 잡힘)`)) {
          let dup = 0;
          for (const f of a.files) { const r = await addEvidence(f.file, sim[0].id, f.kind); if (r.dup) dup++; }
          jui.add = blankAdd(a); location.hash = '#m';
          toast(`기존 비용에 사진 ${a.files.length - dup}장을 붙였습니다`);
          return;
        }
        const id = newCostId();
        let manualId = '';
        if (a.pay === 'paid') { manualId = uid('m'); put('manual', { id: manualId, acct: a.acct, date, amount: total, memo: (a.note || a.vendor || CAT[a.cat]).trim().slice(0, 80), personal: !!a.personal, linkTxn: '', costId: id }); }
        if (a.partyId) ensureParty(M, a.partyId);
        const base = supply != null ? supply : total;
        put('costs', { id, date, cat: a.cat, vendor: a.vendor.trim(), note: a.note.trim(), total, supply, vat, items, alloc: a.jobId ? [{ jobId: a.jobId, amount: base }] : [], pay: a.pay, acct: a.pay === 'paid' ? a.acct : '', manualId, partyId: a.partyId, siteId: a.siteId, personal: !!a.personal, src: 'phone', at: nowTs() });
        commit('cost');
        let dup = 0;
        for (const f of a.files) { const r = await addEvidence(f.file, id, f.kind); if (r.dup) dup++; }
        const msg = `${won(total)}원 ${a.jobId ? '저장' : '미분류로 저장'}${a.files.length ? ` · 사진 ${a.files.length - dup}장` : ''}${dup ? ` (같은 사진 ${dup}장은 이미 있음)` : ''}`;
        jui.add = blankAdd(a); location.hash = '#m'; toast(msg);
      } catch (e) { toast('저장 중 문제: ' + e.message); }
      finally { jui.busy = false; }
    },
    caAttach: async () => {
      const a = A(), M = model();
      if (!a.attachTo) { toast('붙일 비용을 골라주세요'); return; }
      if (!a.files.length) { toast('사진을 먼저 고르세요'); return; }
      jui.busy = true;
      try {
        let costId = a.attachTo.slice(2);
        if (a.attachTo.startsWith('t:')) {
          const t = M.txById.get(costId);
          const ex = costUsing(M, { txnId: t.id });
          if (ex) costId = ex.id;
          else { costId = newCostId(); put('costs', { id: costId, date: t.date, cat: 'expense', vendor: t.desc.replace(/^\d{2,4}(?=\D)/, ''), note: '', total: t.out, supply: null, vat: null, items: [], alloc: [], pay: 'paid', acct: t.acct, txnId: t.id, src: 'bank', at: nowTs() }); commit('cost'); }
        }
        let dup = 0;
        for (const f of a.files) { const r = await addEvidence(f.file, costId, f.kind); if (r.dup) dup++; }
        const n = a.files.length - dup;
        jui.add = blankAdd(a); location.hash = '#m';
        toast(`사진 ${n}장을 붙였습니다${dup ? ` (같은 사진 ${dup}장은 이미 있음)` : ''}. 돈은 새로 잡지 않았습니다`);
      } catch (e) { toast('붙이는 중 문제: ' + e.message); }
      finally { jui.busy = false; }
    },
    evShow: el => { showEvidence(el.dataset.cost); },
    jobSel: el => { jui.jobs.sel = jui.jobs.sel === el.dataset.id ? '' : el.dataset.id; render(); },
    jobAdd: () => {
      const nj = jui.newJob || {};
      const name = document.getElementById('nj-name').value.trim();
      if (!nj.partyId || !nj.siteId) { toast('거래처와 현장을 먼저 고르세요'); return; }
      if (!name) { toast('작업명을 넣어주세요'); return; }
      const j = newJob(nj.partyId, nj.siteId, name, document.getElementById('nj-po').value, document.getElementById('nj-line').value);
      ensureParty(model(), nj.partyId);
      commit('job'); jui.jobs.sel = j.id; toast('작업을 만들었습니다');
    },
    costAlloc: el => {
      const M = model(), c = S().costs[el.dataset.id];
      const jobId = document.getElementById('al-j-' + c.id).value;
      const amt = parseWonInput(document.getElementById('al-a-' + c.id).value);
      const used = (c.alloc || []).reduce((s, x) => s + x.amount, 0), left = costBase(c) - used;
      if (!jobId) { toast('작업을 고르세요'); return; }
      if (!(amt > 0) || amt > left) { toast(`1 ~ ${won(left)}원 사이로 넣어주세요 (남은 금액 넘게 배분하면 두 번 잡히므로 막습니다)`); return; }
      const alloc = [...(c.alloc || [])];
      const ex = alloc.find(x => x.jobId === jobId);
      if (ex) ex.amount += amt; else alloc.push({ jobId, amount: amt });
      patch('costs', c.id, { alloc }); commit('cost');
      toast(amt < left ? `${won(amt)}원 배분 · 남은 ${won(left - amt)}원` : '배분했습니다');
      void M;
    },
    allocDel: el => { const c = S().costs[el.dataset.id]; patch('costs', c.id, { alloc: (c.alloc || []).filter(a => a.jobId !== el.dataset.job) }); commit('cost'); },
    costPaid: el => { patch('costs', el.dataset.id, { pay: 'paid', paidAt: nowTs() }); commit('cost'); toast('지급함으로 표시 (사용자 확인 · 은행 대조 전)'); },
    costDel: el => {
      const c = S().costs[el.dataset.id];
      if (!c || !confirm(`${c.vendor || c.note || ''} ${won(c.total)}원 비용을 지울까요? (사진 기록도 함께 지웁니다. 핸드폰 지출 기록은 그대로)`)) return;
      for (const e of evOf(c.id)) remove('evid', e.id);
      remove('costs', c.id); commit('cost');
    },
    // 통합 장부 → 원가 등록 / 세금계산서 → 원가 등록
    txCost: el => {
      const M = model(), t = M.txById.get(el.dataset.id);
      const ex = costUsing(M, { txnId: t.id });
      if (ex) { toast('이미 원가로 등록된 돈입니다 (두 번 잡지 않음)'); return; }
      put('costs', { id: newCostId(), date: t.date, cat: 'expense', vendor: t.desc.replace(/^\d{2,4}(?=\D)/, ''), note: t.note || '', total: t.out, supply: null, vat: null, items: [], alloc: [], pay: 'paid', acct: t.acct, txnId: t.id, src: 'bank', at: nowTs() });
      commit('cost'); toast('원가로 등록했습니다. 작업·원가 화면에서 작업에 배분하세요');
    },
    invCost: el => {
      const M = model(), i = S().invoices[el.dataset.id];
      const ex = costUsing(M, { invoiceId: i.id });
      if (ex) { toast('이미 원가로 등록된 계산서입니다 (두 번 잡지 않음)'); return; }
      const eff = M.inv.st[i.id]?.eff ?? i.total;
      const ratio = i.total ? eff / i.total : 1;
      const supply = Math.round(i.supply * ratio), vat = eff - supply;
      put('costs', { id: newCostId(), date: i.wdate, cat: 'material', vendor: i.name, note: [i.item, i.note].filter(Boolean).join(' / '), total: eff, supply, vat, items: [], alloc: [], pay: 'invoice', invoiceId: i.id, partyId: '', src: 'invoice', at: nowTs() });
      commit('cost'); toast('매입 계산서를 원가로 등록했습니다. 작업·원가 화면에서 작업에 배분하세요');
    },
  });
  Object.assign(CHG, {
    caSel: el => { if (pickHier(model(), A(), el)) render(); },
    njSel: el => { jui.newJob ||= { partyId: '', siteId: '', jobId: '' }; if (pickHier(model(), jui.newJob, el)) render(); },
    caFiles: el => {
      for (const f of el.files) A().files.push({ file: f, kind: A().kind, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : '' });
      el.value = ''; render();
    },
    caAttachTo: el => { A().attachTo = el.value; },
    caDate: el => { A().date = el.value; },
    caPersonal: el => { A().personal = el.checked; },
    caItemDone: () => render(),
    jPer: el => { jui.jobs[el.dataset.f] = el.value; render(); },
    costCat: el => { patch('costs', el.dataset.id, { cat: el.value }); commit('cost'); },
  });
  let t;
  Object.assign(INP, {
    caF: el => { A()[el.dataset.f] = el.value; },
    caItem: el => { A().items[+el.dataset.i][el.dataset.f] = el.value; },
    jq: el => { jui.jobs.q = el.value; clearTimeout(t); t = setTimeout(render, 250); },
  });
}
