// 화면: 거래처 상세 (계좌 + 매입 계산서 지급 기록)
import { store, commit } from './store.js';
import { model, partners } from './engine.js';
import { esc, won, todayStr, fmtMD, fmtYM, parseWonInput, normName } from './util.js';
import { vendorLive, setVendorAccount, recordPayment, cancelPayment, paylogsOf, canSeeAcct, maskAcct } from './vendors.js';
import { isClosedDate } from './payroll.js';
import { render, toast } from './views.js';

export const pv = { q: '', sel: '', reveal: false, edit: false, form: null, pick: {}, date: '', acct: '', memo: '' };

const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;
const acctName = (M, id) => (M.acctById[id] ? M.acctById[id].name : (id || '-'));
const fmtDay = d => (d ? `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}` : '');

export function payStatus(i, s) {
  if (s.state === 'paid') return tag(`지급완료 · 지급일 ${fmtDay(s.date)}${s.how === 'settled' ? ' (정산 처리)' : s.how === 'auto' ? ' (통장 대조)' : ''}`, 'green');
  if (s.state === 'partial') return tag(`부분지급 ${won(s.paid)} · 잔액 ${won(s.remain)}`, 'amber');
  if (s.state === 'open') return tag('미지급', 'red');
  if (s.state === 'receipt') return tag('영수 (결제하고 받음)', 'gray');
  if (s.state === 'cancel') return tag('취소됨', 'gray');
  if (s.state === 'corr') return tag('수정분 (원본에 합침)', 'gray');
  return tag('해당없음', 'gray');
}

function acctBox(v, p) {
  const see = canSeeAcct();
  if (pv.edit || !v || !v.acctNo) {
    const f = pv.form || (pv.form = { bank: v?.bank || '', holder: v?.holder || p.name, acctNo: '' });
    return `<div class="form">
      <input type="text" id="pv-bank" class="w8" placeholder="은행명" value="${esc(f.bank)}" data-inp="pvF" data-f="bank">
      <input type="text" id="pv-holder" class="w8" placeholder="예금주" value="${esc(f.holder)}" data-inp="pvF" data-f="holder">
      <input type="text" id="pv-acct" class="w12" inputmode="numeric" autocomplete="off" placeholder="${v?.last4 ? `새 계좌 번호 (지금 ****${esc(v.last4)})` : '계좌 번호'}" value="${esc(f.acctNo)}" data-inp="pvF" data-f="acctNo">
      <button class="primary" data-act="pvAcctSave">계좌 저장</button>${v && v.acctNo ? '<button class="ghost" data-act="pvAcctEdit">취소</button>' : ''}</div>
      <div class="hint">계좌 번호는 이 장부(내 구글 드라이브)에만 저장됩니다. 화면에는 끝 4자리만 보입니다.</div>`;
  }
  const full = see && pv.reveal;
  return `<div class="acctbox"><span>${esc(v.bank || '-')}</span><span>예금주 ${esc(v.holder || '-')}</span><b class="acctno">${esc(full ? v.acctNo : maskAcct(v.acctNo))}</b>
    ${see ? `<button class="sm ghost" data-act="pvAcctView">${pv.reveal ? '가리기' : '전체 보기'}</button><button class="sm ghost" data-act="pvAcctCopy">복사</button>` : ''}
    <button class="sm ghost" data-act="pvAcctEdit">수정</button></div>
    ${see ? '' : '<div class="hint">전체 번호 보기·복사는 구글 드라이브에 연결해 장부를 연 사람(장부 주인)만 할 수 있습니다.</div>'}
    ${(v.history || []).length ? `<div class="hint">계좌 변경 기록: ${v.history.slice(-3).map(h => `${esc(h.at.slice(0, 10))} ${esc(h.from || '없음')} → ${esc(h.to || '없음')}`).join(' · ')}</div>` : ''}`;
}

export function partnerDetail(M, p) {
  const invs = M.inv.list.filter(i => i.biz === p.biz && i.kind === 'purchase').sort((a, b) => (a.wdate < b.wdate ? -1 : 1));
  const v = vendorLive(p.biz, p.name);
  if (!pv.date) pv.date = todayStr();
  if (!pv.acct || !M.acctById[pv.acct]) pv.acct = M.accounts[0]?.id || '';
  const picked = invs.filter(i => pv.pick[i.id] != null && M.inv.st[i.id].remain > 0);
  const amtOf = i => parseWonInput(pv.pick[i.id] || '0');
  const total = picked.reduce((s, i) => s + (amtOf(i) || 0), 0);
  const logs = paylogsOf(p.biz);
  return `<section class="card" id="pvd"><div class="row-h"><h2>${esc(p.name)} <span class="muted s">${esc(p.biz)}</span></h2><button class="sm ghost" data-act="pvSel" data-biz="">닫기</button></div>
    <div class="grid5">
      <div class="mc"><div class="l">매입 합계</div><div class="v">${won(p.purchase)}</div></div>
      <div class="mc"><div class="l">지급한 금액</div><div class="v">${won(p.paid)}</div></div>
      <div class="mc ${p.pay ? 'bad' : ''}"><div class="l">미지급</div><div class="v">${won(p.pay)}</div></div>
      <div class="mc"><div class="l">매출 합계</div><div class="v">${won(p.sales)}</div></div>
      <div class="mc"><div class="l">미수금</div><div class="v">${won(p.recv)}</div></div>
    </div>
    <h3>계좌</h3>${acctBox(v, p)}
    <h3>매입 계산서 ${invs.length}건</h3>
    ${invs.length ? `<table class="tbl"><thead><tr><th></th><th>작성일</th><th>품목·비고</th><th class="r">합계</th><th class="r">지급</th><th class="r">잔액</th><th>상태</th><th class="r">이번 지급액</th></tr></thead><tbody>
    ${invs.map(i => { const s = M.inv.st[i.id]; const can = s.remain > 0; const on = can && pv.pick[i.id] != null; return `<tr class="${on ? 'on' : ''}">
      <td>${can ? `<input type="checkbox" data-chg="pvPick" data-id="${esc(i.id)}" ${on ? 'checked' : ''} aria-label="지급할 계산서 고르기">` : ''}</td>
      <td class="nowrap">${fmtMD(i.wdate)}</td><td class="wrap muted">${esc([i.item, i.note].filter(Boolean).join(' / '))}</td>
      <td class="r">${won(s.eff)}</td><td class="r">${s.paid ? won(s.paid) : ''}</td><td class="r">${s.remain ? `<b class="red">${won(s.remain)}</b>` : '0'}</td>
      <td>${payStatus(i, s)}</td>
      <td class="r">${on ? `<input type="text" id="pv-amt-${esc(i.id)}" class="w8 r" inputmode="numeric" value="${esc(pv.pick[i.id])}" data-inp="pvAmt" data-id="${esc(i.id)}">` : ''}</td></tr>`; }).join('')}
    </tbody></table>` : '<div class="muted">이 거래처의 매입 계산서가 없습니다.</div>'}
    ${picked.length ? `<div class="payform">
      <div class="form">
        <label class="inl">지급일 <input type="date" id="pv-date" value="${esc(pv.date)}" data-chg="pvDate"></label>
        <label class="inl">보낸 통장 <select data-chg="pvAcct">${M.accounts.map(a => `<option value="${a.id}" ${a.id === pv.acct ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <input type="text" id="pv-memo" class="w12" placeholder="메모 (선택)" value="${esc(pv.memo)}" data-inp="pvMemo">
        <span>계산서 ${picked.length}건 · 지급 합계 <b id="pv-total">${won(total)}</b>원</span>
        <button class="primary" data-act="pvRecord">지급 기록</button>
      </div>
      <div class="hint"><b>송금하지 않습니다.</b> 은행에서 실제로 보낸 뒤, 보낸 날짜와 금액을 장부에 적는 버튼입니다. 계산서마다 이번에 보낸 금액을 나눠 적으세요 (잔액보다 많이 적을 수 없음).
      통합 장부에는 "거래처 지급 기록"으로 들어가고, 통장 자료가 들어오면 같은 출금과 합쳐집니다 (두 번 잡히지 않음).</div></div>` : (invs.some(i => M.inv.st[i.id].remain > 0) ? '<div class="hint">지급한 계산서 왼쪽 칸을 체크하면 지급 기록 칸이 열립니다.</div>' : '')}
    <h3>지급 기록 ${logs.length}건</h3>
    ${logs.length ? `<table class="tbl"><thead><tr><th>지급일</th><th>통장</th><th class="r">금액</th><th>나눈 내역</th><th>기록</th><th></th></tr></thead><tbody>
    ${logs.map(l => `<tr><td class="nowrap">${fmtDay(l.date)}</td><td>${esc(acctName(M, l.acct))}</td><td class="r"><b>${won(l.total)}</b></td>
      <td>${l.alloc.map(a => { const i = M.inv.byId[a.inv]; return `${i ? fmtMD(i.wdate) + ' 계산서' : '(지워진 계산서)'} ${won(a.amt)}`; }).join(' · ')}${l.memo ? `<div class="hint">${esc(l.memo)}</div>` : ''}</td>
      <td class="muted s">${esc(l.at.slice(0, 16))} · ${esc(l.by || '')}${M.manual.find(m => m.id === l.manualId)?.linkTxn ? ' ' + tag('통장 대조 완료', 'green') : ' ' + tag('통장 대조 전', 'blue')}</td>
      <td class="act"><button class="sm ghost" data-act="pvCancel" data-id="${esc(l.id)}">기록 취소</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="muted">아직 없습니다.</div>'}
  </section>`;
}

export function partnersView(M) {
  const q = normName(pv.q);
  const all = partners(M);
  const list = all.filter(p => !q || normName(p.name).includes(q));
  const sel = pv.sel && all.find(p => p.biz === pv.sel);
  return `
  <h1>거래처</h1>
  ${sel ? partnerDetail(M, sel) : ''}
  <div class="filters"><input type="search" id="pq" placeholder="거래처 검색" value="${esc(pv.q)}" data-inp="pq"></div>
  <table class="tbl"><thead><tr><th>거래처</th><th>사업자번호</th><th>계좌</th><th class="r">매출 합계</th><th class="r">매입 합계</th><th class="r">미수금</th><th class="r">미지급</th><th>최근</th></tr></thead><tbody>
  ${list.map(p => { const v = vendorLive(p.biz, p.name); return `<tr class="${pv.sel === p.biz ? 'on' : ''}"><td><button class="link" data-act="pvSel" data-biz="${esc(p.biz)}">${esc(p.name)}</button></td><td class="muted">${esc(p.biz)}</td>
    <td class="muted">${v && v.last4 ? `${esc(v.bank)} ****${esc(v.last4)}` : ''}</td>
    <td class="r">${p.sales ? won(p.sales) : ''}</td><td class="r">${p.purchase ? won(p.purchase) : ''}</td><td class="r">${p.recv ? `<b class="red">${won(p.recv)}</b>` : ''}</td><td class="r">${p.pay ? `<b class="red">${won(p.pay)}</b>` : ''}</td><td>${fmtMD(p.last)}</td></tr>`; }).join('')}
  </tbody></table>
  <div class="hint">거래처 이름을 누르면 계좌 등록과 지급 기록 화면이 열립니다.</div>`;
}

const closedMsg = d => { if (isClosedDate(d)) { toast(`${fmtYM(d.slice(0, 7))}은 월 마감된 달이라 기록할 수 없습니다. [월 마감] 화면에서 마감 해제(사유 입력) 후 하세요`); return true; } return false; };

export function extendPartnerUI({ ACT, CHG, INP }) {
  let busy = false, qt;
  Object.assign(ACT, {
    pvSel: el => { const b = el.dataset.biz; pv.sel = pv.sel === b ? '' : b; pv.reveal = false; pv.edit = false; pv.form = null; pv.pick = {}; pv.memo = ''; pv.date = todayStr(); render(); if (pv.sel) document.getElementById('pvd')?.scrollIntoView({ block: 'start' }); },
    pvAcctEdit: () => { pv.edit = !pv.edit; pv.form = null; render(); },
    pvAcctView: () => { if (!canSeeAcct()) return; pv.reveal = !pv.reveal; render(); },
    pvAcctCopy: async () => {
      const p = partners(model()).find(x => x.biz === pv.sel); const v = p && vendorLive(p.biz, p.name);
      if (!v || !canSeeAcct()) return;
      try { await navigator.clipboard.writeText(v.acctNo); toast('계좌 번호를 복사했습니다'); } catch { toast('복사가 막혔습니다. [전체 보기]로 보고 직접 적어주세요'); }
    },
    pvAcctSave: () => {
      const p = partners(model()).find(x => x.biz === pv.sel); const f = pv.form || {};
      if (!p) return;
      const old = vendorLive(p.biz, p.name);
      if (!f.bank?.trim() || !f.holder?.trim()) { toast('은행명과 예금주를 넣어주세요'); return; }
      if (!f.acctNo && !old?.acctNo) { toast('계좌 번호를 넣어주세요'); return; }
      const r = setVendorAccount(p.biz, p.name, { bank: f.bank, holder: f.holder, acctNo: f.acctNo || old.acctNo });
      if (r.err) { toast(r.err); return; }
      commit('vendor'); pv.edit = false; pv.form = null; pv.reveal = false;
      toast(r.changed ? '계좌를 바꿨습니다 (변경 기록에 끝 4자리만 남김)' : '계좌를 저장했습니다');
    },
    pvRecord: () => {
      if (busy) return;
      const M = model();
      const p = partners(M).find(x => x.biz === pv.sel);
      if (!p || closedMsg(pv.date)) return;
      const ids = Object.keys(pv.pick).filter(id => M.inv.st[id]?.remain > 0);
      const alloc = ids.map(id => ({ inv: id, amt: parseWonInput(pv.pick[id] || '') }));
      if (alloc.some(a => !Number.isSafeInteger(a.amt) || a.amt <= 0)) { toast('고른 계산서마다 지급액을 1원 이상 넣어주세요'); return; }
      const total = alloc.reduce((s, a) => s + a.amt, 0);
      const lines = alloc.map(a => `· ${M.inv.byId[a.inv].wdate} 계산서 ${won(a.amt)}원${a.amt < M.inv.st[a.inv].remain ? ` (잔액 ${won(M.inv.st[a.inv].remain - a.amt)}원 남음)` : ''}`).join('\n');
      if (!confirm(`${p.name}에 보낸 ${won(total)}원을 장부에 기록합니다.\n(앱은 송금하지 않습니다. 이미 은행에서 보낸 경우에만 기록하세요)\n\n지급일 ${pv.date} · ${acctName(M, pv.acct)}\n${lines}`)) return;
      busy = true;
      try {
        const r = recordPayment(M, { date: pv.date, acct: pv.acct, alloc, memo: pv.memo });
        if (r.err) { toast(r.err); return; }
        commit('paylog'); pv.pick = {}; pv.memo = '';
        toast(`${won(r.total)}원 지급을 기록했습니다 (통장 대조 전)`);
      } finally { busy = false; }
    },
    pvCancel: el => {
      const l = store.state.paylogs[el.dataset.id];
      if (!l || closedMsg(l.date)) return;
      if (!confirm(`${fmtDay(l.date)} ${l.name} ${won(l.total)}원 지급 기록을 취소할까요?\n(계산서는 다시 미지급으로 돌아가고, 통합 장부의 지급 기록도 같이 지워집니다)`)) return;
      if (cancelPayment(l.id)) { commit('paylog'); toast('지급 기록을 취소했습니다'); }
    },
  });
  Object.assign(CHG, {
    pvPick: el => { const id = el.dataset.id; if (el.checked) pv.pick[id] = String(model().inv.st[id].remain); else delete pv.pick[id]; render(); },
    pvDate: el => { pv.date = el.value; },
    pvAcct: el => { pv.acct = el.value; },
  });
  Object.assign(INP, {
    pq: el => { pv.q = el.value; clearTimeout(qt); qt = setTimeout(render, 250); },
    pvF: el => { (pv.form ||= {})[el.dataset.f] = el.value; },
    pvMemo: el => { pv.memo = el.value; },
    pvAmt: el => {
      pv.pick[el.dataset.id] = el.value;
      const t = Object.keys(pv.pick).reduce((s, id) => s + (parseWonInput(pv.pick[id] || '0') || 0), 0);
      const out = document.getElementById('pv-total'); if (out) out.textContent = won(t);
    },
  });
}
