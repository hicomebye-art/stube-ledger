// 급여 화면 (PC): 16일 급여 / 주급 / 직원 관리 / 이체 확인표 / 정산표 PNG / 월 마감
import { store, live, put, patch, commit } from './store.js';
import { model, occurrences, lastCovered } from './engine.js';
import { esc, won, todayStr, addDays, ymOf, addMonths, daysInMonth, fmtMD, fmtYM, uid, nowTs, parseWonInput, normName } from './util.js';
import * as drive from './drive.js';
import {
  EMP_KIND, DAY_KIND, wdName, dow, defaultDayKind, employees, empById, acctReady, setAccount, confirmAccount,
  runIdMonthly, runIdWeekly, runOf, monthlyPeriod, weekDays, weeksTouching, dayAmount, calcDaily, runAmounts,
  eventsToDays, payState, laborByMonth, closeOf, isClosedDate, closeMonth, reopenMonth, audit, deviceName, parseWageLedger,
} from './payroll.js';
import { render, toast } from './views.js';

const S = () => store.state;
const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;
const thisYm = () => ymOf(todayStr());
export const pui = { tab: 'm16', ym: thisYm(), sel: '', cals: null, ledger: null, closeYm: addMonths(thisYm(), -1) };
const mdw = d => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 (${wdName(d)})` : '');

function closedBlock(dateOrYm) {
  if (isClosedDate(dateOrYm)) { toast(`${fmtYM(String(dateOrYm).slice(0, 7))}은 월 마감된 달입니다. [월 마감] 화면에서 마감 해제(사유 입력) 후 고칠 수 있습니다`); return true; }
  return false;
}

// ───── 화면: 급여 ─────
export function payView(M) {
  const tabs = [['m16', '16일 급여'], ['weekly', '주급'], ['emps', '직원 관리'], ['xfer', '이체 확인표']];
  const body = pui.tab === 'weekly' ? weeklyTab(M) : pui.tab === 'emps' ? empsTab() : pui.tab === 'xfer' ? xferTab(M) : m16Tab(M);
  return `<h1>급여</h1>
    <div class="filters">${tabs.map(([k, l]) => `<button class="${pui.tab === k ? 'primary' : ''}" data-act="pyTab" data-k="${k}">${l}</button>`).join('')}
      ${pui.tab !== 'emps' ? `<label class="inl">지급 월 <input type="month" value="${pui.ym}" data-chg="pyYm"></label>` : ''}
      ${closeOf(pui.ym) && pui.tab !== 'emps' ? tag(`${fmtYM(pui.ym)} 월 마감됨 — 수정 불가`, 'red') : ''}</div>
    ${body}
    ${pui.sel ? runDetail(M, pui.sel) : ''}`;
}

function statusOf(run, e) {
  if (!run || run.status === 'waiting') return tag('급여자료 대기', 'gray');
  if (run.status === 'confirmed') return tag('확정', 'green') + (run.pending ? ' ' + tag('변경 자료 있음', 'amber') : '');
  return tag('확인 필요', 'red');
}

function m16Tab(M) {
  const ym = pui.ym;
  const list = employees().filter(e => e.kind === 'ledger' || e.kind === 'monthlyDaily');
  let sub = 0; const waiting = [];
  const rows = list.map(e => {
    const id = runIdMonthly(e.id, ym), run = runOf(id);
    const payDate = run?.payDate || `${ym}-16`;
    const amt = run && runAmounts(run);
    if (amt) sub += amt.net; else waiting.push(e.name);
    const ps = amt ? payState(M, run, e) : null;
    const per = e.kind === 'monthlyDaily' ? monthlyPeriod(ym) : null;
    const basis = e.kind === 'ledger' ? `임금대장 ${run?.attrYm ? fmtYM(run.attrYm) + ' 귀속' : '(귀속월 ?)'}` : `${fmtMD(per.from)}~${fmtMD(per.to)} 출근 × 일당`;
    const issues = run && run.status === 'draft' && e.kind === 'monthlyDaily' ? calcDaily(e, run).issues : run && run.status === 'draft' && run.net == null ? ['실지급액이 없음'] : [];
    return `<tr><td><b>${esc(e.name)}</b></td><td class="wrap">${esc(basis)}</td>
      <td class="nowrap">${mdw(payDate)}${run?.payDateChanged ? ' ' + tag('이번 달 변경') : ''}</td>
      <td class="r">${amt ? won(amt.gross ?? amt.net) : (run?.gross != null ? `<span class="muted">${won(run.gross)}</span>` : '-')}</td>
      <td class="r">${amt && amt.deduction != null ? won(amt.deduction) : '-'}</td>
      <td class="r"><b>${amt ? won(amt.net) : '-'}</b>${run?.pending ? `<div class="hint">변경 자료: ${won(run.net)} → ${won(run.pending.net)} (차액 ${won(run.pending.net - run.net)})</div>` : ''}</td>
      <td>${statusOf(run, e)}${issues.length ? `<div class="hint">${issues.map(esc).join('<br>')}</div>` : ''}</td>
      <td>${ps ? tag(ps.label, { bank: 'green', user: 'blue', part: 'amber', unpaid: 'red', unverified: 'gray', due: '' }[ps.k] || '') : ''}</td>
      <td class="act">${[
        e.kind === 'monthlyDaily' ? `<button class="sm" data-act="pyCal" data-emp="${e.id}" data-id="${id}">출근 기록 불러오기</button>` : '',
        run ? `<button class="sm ghost" data-act="pySel" data-id="${id}">자세히</button>` : '',
        run && run.status === 'draft' ? `<button class="sm primary" data-act="pyConfirm" data-id="${id}">급여 확정</button>` : '',
        `<button class="sm ghost" data-act="pyDate" data-emp="${e.id}" data-id="${id}">이번 달만 지급일 변경</button>`,
        e.kind === 'monthlyDaily' && run ? `<button class="sm ghost" data-act="pyPreview" data-id="${id}">정산표 미리보기</button>` : '',
      ].join('')}</td></tr>`;
  }).join('');
  return `<section class="card"><div class="row-h"><h2>${fmtYM(ym)} 16일 급여 (직접 이체)</h2><span class="muted">주급 직원은 여기 나오지 않고 [주급]에만 나옵니다</span></div>
    <div class="sumbar">확정 소계 <b>${won(sub)}</b>원${waiting.length ? ` · 미확정 ${waiting.length}명 (${waiting.map(esc).join(', ')}) — 지급 예정 합계에 넣지 않음` : list.length ? ' · 전원 확정' : ''}</div>
    ${list.length ? `<table class="tbl"><thead><tr><th>직원</th><th>계산 기준</th><th>지급일</th><th class="r">공제 전</th><th class="r">공제</th><th class="r">실지급</th><th>급여</th><th>지급 상태</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted">직원 관리에서 16일 급여 직원(임금대장 / 월 정산)을 등록하세요.</div>'}
  </section>
  <section class="card"><h2>세무법인 임금대장 가져오기</h2>
    <div class="hint">임금대장 엑셀을 직접 고르면 직원별 <b>차인지급액(실수령액)</b>을 가져옵니다. 임금명세서는 가져오지 않습니다. 같은 파일은 다시 넣지 않고, 이미 확정한 급여는 덮어쓰지 않습니다(변경 전후·차액만 표시).</div>
    <div class="btns"><label class="btn primary">임금대장 엑셀 선택<input type="file" accept=".xls,.xlsx" data-chg="pyLedger" hidden></label></div>
    ${pui.ledger ? ledgerPreview() : ''}
  </section>`;
}

function ledgerPreview() {
  const L = pui.ledger;
  const close = '<button class="sm ghost" data-act="pyLedgerCancel">닫기</button>';
  if (L.error) return `<div class="errline">${esc(L.error)} ${close}</div>`;
  if (L.dupFile) return `<div class="note">이미 가져온 파일입니다 (${esc(L.file)}). 다시 넣지 않았습니다. ${close}</div>`;
  const emps = employees();
  const rows = L.list.map(x => {
    const cands = emps.filter(e => normName(e.name) === normName(x.name));
    const e = cands.length === 1 ? cands[0] : null;
    let st;
    if (!e) st = tag(cands.length > 1 ? '같은 이름 직원 여러 명 — 확인' : '직원 목록에 없음 — 가져오지 않음', 'red');
    else if (e.kind !== 'ledger') st = tag(`중복 확인: ${EMP_KIND[e.kind]} 직원 — 금액을 가져오지 않음`, 'amber');
    else st = tag('가져옴', 'green');
    return `<tr><td>${esc(x.name)}</td><td class="r">${x.gross != null ? won(x.gross) : '-'}</td><td class="r">${x.deduction != null ? won(x.deduction) : '-'}</td><td class="r"><b>${won(x.net)}</b></td><td>${st}</td></tr>`;
  }).join('');
  return `<div class="impgrid">
      <div><span class="muted">파일</span><b>${esc(L.file)}</b></div>
      <div><span class="muted">귀속월</span><input type="month" id="wl-attr" value="${L.attrYm || ''}">${L.attrYm ? '' : ' <span class="red">파일에서 못 읽음 — 직접 선택</span>'}</div>
      <div><span class="muted">지급일</span><input type="date" id="wl-pay" value="${L.payDate || `${pui.ym}-16`}">${L.payDate ? ' (파일)' : ' (16일 기본)'}</div>
    </div>
    <table class="tbl"><thead><tr><th>성명</th><th class="r">지급총액</th><th class="r">공제총액</th><th class="r">차인지급액</th><th>처리</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="btns"><button class="primary" data-act="pyLedgerDo">임금대장 가져오기 (확정은 따로)</button><button class="ghost" data-act="pyLedgerCancel">취소</button></div>`;
}

function weeklyTab(M) {
  const ym = pui.ym;
  const list = employees().filter(e => e.kind === 'weekly');
  if (!list.length) return '<section class="card"><div class="muted">직원 관리에서 주급 직원을 등록하세요.</div></section>';
  return list.map(e => {
    const rows = weeksTouching(ym).map(mon => {
      const w = weekDays(mon), id = runIdWeekly(e.id, mon), run = runOf(id);
      const amt = run && runAmounts(run);
      const draft = run && run.status === 'draft' ? calcDaily(e, run) : null;
      const ps = amt ? payState(M, run, e) : null;
      const pick = d => `<label class="chk"><input type="radio" name="pd-${id}" data-chg="pyWeekDay" data-emp="${e.id}" data-id="${id}" data-mon="${mon}" value="${d}" ${run?.payDate === d ? 'checked' : ''}> ${mdw(d)}</label>`;
      return `<tr><td class="nowrap">${fmtMD(w.from)} ~ ${fmtMD(w.to)}</td>
        <td>${pick(w.sat)} ${pick(w.sun)}${run?.payDate ? '' : ' ' + tag('지급일 미정', 'amber')}</td>
        <td class="r">${run ? (run.days || []).filter(x => x.on !== false).length + '일' : '-'}</td>
        <td class="r"><b>${amt ? won(amt.net) : draft && draft.net != null ? `<span class="muted">${won(draft.net)}</span>` : '-'}</b></td>
        <td>${statusOf(run, e)}${draft && draft.issues.length ? `<div class="hint">${draft.issues.map(esc).join('<br>')}</div>` : ''}</td>
        <td>${ps ? tag(ps.label, { bank: 'green', user: 'blue', part: 'amber', unpaid: 'red', unverified: 'gray', due: '' }[ps.k] || '') : ''}</td>
        <td class="act"><button class="sm" data-act="pyCal" data-emp="${e.id}" data-id="${id}" data-mon="${mon}">출근 기록 불러오기</button>${run ? `<button class="sm ghost" data-act="pySel" data-id="${id}">자세히</button>` : ''}${run && run.status === 'draft' ? `<button class="sm primary" data-act="pyConfirm" data-id="${id}">급여 확정</button>` : ''}${run ? `<button class="sm ghost" data-act="pyPreview" data-id="${id}">정산표 미리보기</button>` : ''}</td></tr>`;
    }).join('');
    return `<section class="card"><div class="row-h"><h2>주급 · ${esc(e.name)}</h2><span class="muted">지급일은 그 주 토요일 또는 일요일 중 매주 선택 (월요일 없음)</span></div>
      <table class="tbl"><thead><tr><th>주 (월~일)</th><th>지급일</th><th class="r">출근</th><th class="r">실지급</th><th>급여</th><th>지급 상태</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
}

function empsTab() {
  const list = live('employees').sort((a, b) => (a.order || 0) - (b.order || 0));
  const calOpts = cur => `<option value="">캘린더 선택</option>${(pui.cals || []).map(c => `<option value="${esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${cur && !(pui.cals || []).some(c => c.id === cur) ? `<option value="${esc(cur)}" selected>(연결된 캘린더)</option>` : ''}`;
  return `<section class="card"><div class="row-h"><h2>직원 관리</h2><button class="primary" data-act="pyEmpAdd">직원 추가</button></div>
    <div class="hint">계좌는 <b>은행·예금주·끝 4자리만</b> 저장합니다 (전체 번호는 장부·드라이브에 저장하지 않음). 계좌를 새로 넣거나 바꾸면 [계좌 확인]을 눌러야 "이체 준비 완료"가 됩니다. 이름만으로 계좌를 자동 연결하지 않습니다.</div>
    <div class="btns">${drive.calendar.connected() ? `${tag('구글 캘린더 연결됨 (읽기 전용)', 'green')} <button class="sm ghost" data-act="pyCalList">캘린더 목록 다시 읽기</button>` : '<button data-act="pyCalConnect">구글 캘린더 연결 (읽기 전용)</button>'}</div>
    ${list.length ? `<table class="tbl"><thead><tr><th>이름 · ID</th><th>계산 기준</th><th>일당 (평일 / 토·일·휴일)</th><th>공제</th><th>출근 캘린더</th><th>계좌 (은행 / 예금주 / 끝 4자리)</th><th></th></tr></thead><tbody>
    ${list.map(e => `<tr class="${e.active === false ? 'dim' : ''}">
      <td><input type="text" class="w8" value="${esc(e.name)}" data-chg="pyEmp" data-id="${e.id}" data-f="name"><div class="muted s">${esc(e.id)}</div></td>
      <td><select data-chg="pyEmp" data-id="${e.id}" data-f="kind">${Object.entries(EMP_KIND).map(([k, l]) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${e.kind === 'ledger' ? '<span class="muted">임금대장 금액 사용</span>' : `<input type="text" inputmode="numeric" class="w8 r" value="${e.rates?.weekday ? won(e.rates.weekday) : ''}" placeholder="평일" data-chg="pyRate" data-id="${e.id}" data-f="weekday"> / <input type="text" inputmode="numeric" class="w8 r" value="${e.rates?.weekend ? won(e.rates.weekend) : ''}" placeholder="토·일·휴일" data-chg="pyRate" data-id="${e.id}" data-f="weekend">`}</td>
      <td>${e.kind === 'ledger' ? '<span class="muted">임금대장 기준</span>' : `<select data-chg="pyDed" data-id="${e.id}"><option value="">선택</option><option value="none" ${e.deduct?.mode === 'none' ? 'selected' : ''}>공제 없음</option><option value="3.3" ${e.deduct?.mode === '3.3' ? 'selected' : ''}>3.3%</option><option value="fixed" ${e.deduct?.mode === 'fixed' ? 'selected' : ''}>정액 ${e.deduct?.mode === 'fixed' ? won(e.deduct.amount) + '원' : ''}</option></select>
        <label class="chk"><input type="checkbox" data-chg="pyDedOk" data-id="${e.id}" ${e.deduct?.confirmed ? 'checked' : ''}> 확인함</label>`}</td>
      <td>${e.kind === 'ledger' ? '' : `<select data-chg="pyEmp" data-id="${e.id}" data-f="calId">${calOpts(e.calId)}</select><input type="text" class="w8" placeholder="제목에 들어간 말 (선택)" value="${esc(e.calKeyword || '')}" data-chg="pyEmp" data-id="${e.id}" data-f="calKeyword">`}</td>
      <td class="nowrap"><input type="text" class="w6" placeholder="은행" value="${esc(e.bank || '')}" id="ac-b-${e.id}"> <input type="text" class="w6" placeholder="예금주" value="${esc(e.holder || '')}" id="ac-h-${e.id}"> <input type="text" class="w4" inputmode="numeric" maxlength="4" placeholder="끝4" value="${esc(e.last4 || '')}" id="ac-l-${e.id}">
        <button class="sm" data-act="pyAcctSave" data-id="${e.id}">저장</button>
        ${acctReady(e) ? tag('이체 준비 완료', 'green') : e.last4 ? `${tag('확인 전', 'amber')} <button class="sm primary" data-act="pyAcctOk" data-id="${e.id}">계좌 확인</button>` : tag('계좌 없음', 'gray')}
        ${(e.acct?.history || []).length ? `<div class="muted s">이전 계좌 ${e.acct.history.length}개 기록</div>` : ''}</td>
      <td class="act"><button class="sm ghost" data-act="pyEmpActive" data-id="${e.id}">${e.active === false ? '다시 사용' : '사용 안 함'}</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="muted">아직 등록된 직원이 없습니다.</div>'}
  </section>`;
}

function xferTab(M) {
  const ym = pui.ym;
  const runs = live('payruns').filter(r => r.status === 'confirmed' && (ymOf(r.payDate || r.weekOf || '') === ym || (r.payDate && r.payDate < `${ym}-01` && payState(M, r, empById(r.empId)).remain > 0)))
    .sort((a, b) => ((a.payDate || '9') < (b.payDate || '9') ? -1 : 1));
  const rows = runs.map(r => {
    const e = empById(r.empId) || {}; const ps = payState(M, r, e);
    const carried = r.payDate && r.payDate < `${ym}-01`;
    return `<tr><td>${esc(e.name || '?')}${carried ? ' ' + tag(`이월 · ${fmtYM(ymOf(r.payDate))} 지급분`, 'amber') : ''}<div class="muted s">${r.type === 'weekly' ? '주급' : '급여'} · ${r.payDate ? mdw(r.payDate) : '지급일 미정'}</div></td>
      <td>${esc(e.bank || '-')}</td><td>${esc(e.holder || '-')}</td><td>${e.last4 ? '****' + esc(e.last4) : '-'} ${acctReady(e) ? tag('이체 준비 완료', 'green') : tag('계좌 확인 필요', 'red')}</td>
      <td class="r"><b>${won(ps.remain ?? r.net)}</b>${ps.paid ? `<div class="muted s">전체 ${won(r.net)} 중 지급 ${won(ps.paid)}</div>` : ''}</td>
      <td>${tag(ps.label, { bank: 'green', user: 'blue', part: 'amber', unpaid: 'red', unverified: 'gray', due: '' }[ps.k] || '')}${ps.hint ? `<div class="hint">같은 금액 거래 ${fmtMD(ps.hint.date)} 있음 — 금액만 같아서 자동 확정하지 않음</div>` : ''}</td>
      <td class="act">${ps.k !== 'bank' && ps.k !== 'user' ? `<button class="sm" data-act="pyPaid" data-id="${r.id}">지급 확인</button>` : ''}${(r.paid || []).length ? `<button class="sm ghost" data-act="pyPaidUndo" data-id="${r.id}">지급 확인 취소</button>` : ''}</td></tr>`;
  }).join('');
  return `<section class="card"><h2>${fmtYM(ym)} 이체 확인표</h2>
    <div class="hint">앱은 송금하지 않습니다. "지급 확인"은 대표님이 누른 확인, "은행 거래 대조 완료"는 통장 자료에서 예금주 이름과 금액이 확인된 것입니다. 계좌 전체 번호는 저장하지 않습니다 (끝 4자리만).</div>
    ${runs.length ? `<table class="tbl"><thead><tr><th>직원명</th><th>은행</th><th>예금주</th><th>계좌 끝 4자리</th><th class="r">이체 금액</th><th>지급 상태</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted">이 달에 확정된 급여가 없습니다.</div>'}</section>`;
}

function runDetail(M, id) {
  const run = runOf(id); if (!run) return '';
  const e = empById(run.empId) || {};
  const daily = e.kind !== 'ledger';
  const calc = daily ? calcDaily(e, run) : null;
  const locked = run.status === 'confirmed';
  const days = (run.days || []).map((d, i) => {
    const a = dayAmount(e, d);
    return `<tr class="${d.on === false ? 'dim' : ''}"><td><input type="checkbox" ${d.on !== false ? 'checked' : ''} ${locked ? 'disabled' : ''} data-chg="pyDayOn" data-id="${id}" data-i="${i}"></td>
      <td class="nowrap">${mdw(d.date)}</td>
      <td><select ${locked ? 'disabled' : ''} data-chg="pyDayKind" data-id="${id}" data-i="${i}">${Object.entries(DAY_KIND).map(([k, l]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${d.kind === 'custom' ? `<input type="text" class="w8 r" inputmode="numeric" value="${d.amount ? won(d.amount) : ''}" placeholder="금액" ${locked ? 'disabled' : ''} data-chg="pyDayAmt" data-id="${id}" data-i="${i}">` : ''}</td>
      <td class="r">${a != null ? won(a) : '<span class="red">?</span>'}</td>
      <td class="wrap">${(d.events || []).map(x => esc(x.title) + (x.place ? ` <span class="muted">@${esc(x.place)}</span>` : '')).join('<br>') || '<span class="muted">직접 추가</span>'}${(d.events || []).length > 1 ? ' ' + tag(`일정 ${d.events.length}개 → 1일로 계산`, 'blue') : ''}</td>
      <td><input type="text" class="w8" value="${esc(d.note || '')}" placeholder="비고" ${locked ? 'disabled' : ''} data-chg="pyDayNote" data-id="${id}" data-i="${i}"></td></tr>`;
  }).join('');
  return `<section class="card"><div class="row-h"><h2>${esc(e.name)} · ${run.type === 'weekly' ? '주급' : '16일 급여'} ${run.period ? `${fmtMD(run.period.from)}~${fmtMD(run.period.to)}` : run.attrYm ? fmtYM(run.attrYm) + ' 귀속' : ''}</h2><button class="sm ghost" data-act="pySel" data-id="">닫기</button></div>
    ${run.pending ? `<div class="errline">새 자료가 확정 금액과 다릅니다: ${won(run.net)} → ${won(run.pending.net)} (차액 ${won(run.pending.net - run.net)}) · ${esc(run.pending.reason || '')}
      <button class="sm primary" data-act="pyPendApply" data-id="${id}">변경 반영</button><button class="sm ghost" data-act="pyPendDrop" data-id="${id}">무시</button></div>` : ''}
    ${(run.revisions || []).length ? `<div class="hint">변경 기록: ${run.revisions.map(r => `${esc(r.at)} ${won(r.before)} → ${won(r.after)} (차액 ${won(r.after - r.before)})${r.reason ? ' · ' + esc(r.reason) : ''}`).join(' / ')}</div>` : ''}
    ${daily ? `<table class="tbl"><thead><tr><th>출근</th><th>날짜</th><th>근무 구분</th><th class="r">금액</th><th>캘린더 일정 (현장)</th><th>비고</th></tr></thead><tbody>${days}</tbody></table>
      ${locked ? '' : `<div class="btns"><button class="sm" data-act="pyDayAdd" data-id="${id}">날짜 직접 추가</button><button class="sm ${run.daysChecked ? 'ghost' : 'primary'}" data-act="pyDaysOk" data-id="${id}">${run.daysChecked ? '출근일 확인됨 (다시 확인)' : '출근일 확인 완료'}</button></div>`}
      <div class="sumbar">공제 전 ${calc.gross != null ? won(calc.gross) : '?'} · 공제 ${calc.deduction != null ? won(calc.deduction) : '?'} · 실지급 <b>${calc.net != null ? won(calc.net) : '?'}</b></div>
      ${calc.issues.length && !locked ? `<div class="errline">확인 필요: ${calc.issues.map(esc).join(' · ')}</div>` : ''}`
    : `<div class="kv"><span>임금대장 파일</span><b>${esc(run.src?.file || '-')}</b></div><div class="kv"><span>지급총액 / 공제총액</span><b>${run.gross != null ? won(run.gross) : '-'} / ${run.deduction != null ? won(run.deduction) : '-'}</b></div><div class="kv"><span>차인지급액</span><b>${run.net != null ? won(run.net) : '-'}</b></div>`}
    <div class="btns">${!locked ? `<button class="primary" data-act="pyConfirm" data-id="${id}">급여 확정</button>` : tag(`확정 ${run.confirmedAt || ''}`, 'green')}${daily ? `<button data-act="pyPreview" data-id="${id}">정산표 미리보기</button>` : ''}</div>
  </section>`;
}

// ───── 정산표 (카톡용 PNG) ─────
// 장부에서 확정한 근무 내역·금액을 그대로 그림 (여기서 다시 계산하지 않음). 확정 전에는 "확인 필요"로만 미리보기.
export function sheetModel(run, e) {
  const amt = runAmounts(run);
  const ok = !!amt;
  const src = ok ? amt : (() => { const c = calcDaily(e, run); return { gross: c.gross, deduction: c.deduction, net: c.net, days: c.lines }; })();
  const days = (src.days || []).filter(d => d.on !== false);
  const cnt = {}; for (const d of days) { const k = d.kind; cnt[k] = (cnt[k] || []); cnt[k].push(d); }
  const basis = Object.entries(cnt).map(([k, ds]) => { const a = ds[0].amount; const same = ds.every(x => x.amount === a); return `${DAY_KIND[k].replace(' 근무', '')} ${ds.length}일${same && a != null ? ` × ${won(a)}원` : ''}`; }).join(' + ');
  const payDate = run.payDate || '';
  return {
    ok, weekly: run.type === 'weekly', name: e.name || '',
    title: `[${run.type === 'weekly' ? '주급' : '월급'} 정산] ${e.name || ''}`,
    sub: `${payDate ? `${payDate.slice(0, 4)}년 ${Number(payDate.slice(5, 7))}월 지급` : '지급일 미정'}  |  근무내역 확인`,
    payDate: payDate ? `${Number(payDate.slice(5, 7))}월 ${Number(payDate.slice(8))}일 (${wdName(payDate)})` : '지급일 미정',
    period: run.period ? `${run.period.from.replaceAll('-', '.').slice(0, 4)}년 ${Number(run.period.from.slice(5, 7))}월 ${Number(run.period.from.slice(8))}일 (${wdName(run.period.from)}) ~ ${Number(run.period.to.slice(5, 7))}월 ${Number(run.period.to.slice(8))}일 (${wdName(run.period.to)})` : '',
    rows: days.map(d => ({ date: `${Number(d.date.slice(5, 7))}월 ${Number(d.date.slice(8))}일`, wd: wdName(d.date), kind: d.kind === 'weekday' ? '평일 근무' : d.kind === 'custom' ? '별도 금액' : d.kind === 'half' ? '반일 근무' : d.kind === 'holiday' ? '휴일 근무 (1.5배)' : `${wdName(d.date)}요일 근무 (1.5배)`, amount: d.amount, note: d.note || (d.kind === 'weekend' || d.kind === 'holiday' ? '휴일 1.5배 적용' : d.kind === 'half' ? '반일' : ''), special: d.kind !== 'weekday' })),
    days: days.length, gross: src.gross, deduction: src.deduction, net: src.net,
    dedLabel: e.deduct?.mode === '3.3' ? '3.3% 공제' : e.deduct?.mode === 'fixed' ? '공제' : '공제',
    basis, account: { bank: e.bank || '', holder: e.holder || '', last4: e.last4 || '' },
  };
}

export function drawSheet(m) {
  const W = 640, P = 24, rowH = 22.6;
  const H = 210 + 30 + m.rows.length * rowH + 30 + 120 + 70;
  const c = document.createElement('canvas');
  const k = 2; c.width = W * k; c.height = Math.ceil(H) * k;
  const g = c.getContext('2d'); g.scale(k, k);
  const F = (w, s) => `${w} ${s}px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif`;
  const text = (s, x, y, font, color = '#1f2937', align = 'left') => { g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y); };
  const won2 = n => (n == null ? '?' : n.toLocaleString('ko-KR') + '원');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  // 상단
  g.fillStyle = '#4f9b8f'; g.fillRect(P, 18, 5, 52);
  text(m.title, P + 16, 46, F(800, 26));
  text(m.sub, P + 16, 70, F(500, 14), '#4b5563');
  g.fillStyle = '#e6f2ef'; roundRect(g, W - P - 150, 14, 150, 56, 10); g.fill();
  text('지급 예정일', W - P - 75, 36, F(500, 12), '#2f5d50', 'center');
  text(m.payDate, W - P - 75, 60, F(800, 17), '#1f2937', 'center');
  if (m.period) text(`정산 기간: ${m.period}`, P, 104, F(400, 14), '#374151');
  text('근무 내역', P, 140, F(800, 17));
  text('장부 확정 기준', W - P, 140, F(400, 11), '#6b7280', 'right');
  // 표
  const cols = [P, P + 110, P + 165, P + 340, P + 470, W - P];
  const mid = i => (cols[i] + cols[i + 1]) / 2;
  let y = 152;
  g.fillStyle = '#dbe8f6'; g.fillRect(P, y, W - 2 * P, rowH);
  ['날짜', '요일', '근무 구분', '지급 금액', '비고'].forEach((h, i) => text(h, mid(i), y + 16, F(700, 12), '#1f2937', 'center'));
  y += rowH;
  m.rows.forEach((r, i) => {
    g.fillStyle = r.special ? '#fde8ea' : i % 2 ? '#f5f8fc' : '#ffffff'; g.fillRect(P, y, W - 2 * P, rowH);
    const col = r.special ? '#b4232f' : '#1f2937', wt = r.special ? 700 : 400;
    [r.date, r.wd, r.kind, r.amount != null ? won2(r.amount) : '?', r.note].forEach((s, j) => text(s, mid(j), y + 16, F(wt, 12), col, 'center'));
    y += rowH;
  });
  g.fillStyle = '#dbe8f6'; g.fillRect(P, y, W - 2 * P, rowH + 2);
  text('합계', mid(0), y + 17, F(800, 12), '#1f2937', 'center');
  text(`${m.days}일`, mid(1), y + 17, F(800, 12), '#1f2937', 'center');
  text(won2(m.gross), mid(3), y + 17, F(800, 12), '#1f2937', 'center');
  y += rowH + 18;
  // 정산 내역
  g.fillStyle = '#eaf1f8'; roundRect(g, P, y, W - 2 * P, 104, 10); g.fill();
  text('정산 내역', P + 16, y + 26, F(800, 15));
  text('급여 합계', P + 170, y + 26, F(400, 14)); text(won2(m.gross), W - P - 16, y + 26, F(400, 14), '#1f2937', 'right');
  text(m.dedLabel, P + 170, y + 48, F(400, 14)); text(m.deduction == null ? '?' : '- ' + won2(m.deduction), W - P - 16, y + 48, F(400, 14), '#1f2937', 'right');
  g.strokeStyle = '#c9d6e3'; g.beginPath(); g.moveTo(P + 160, y + 60); g.lineTo(W - P - 10, y + 60); g.stroke();
  text('실지급액', P + 170, y + 88, F(800, 16), '#1d4ed8'); text(won2(m.net), W - P - 16, y + 92, F(900, 28), '#1d4ed8', 'right');
  y += 120;
  // 계산 기준 / 계좌
  text('계산 기준', P, y + 4, F(800, 13));
  text(m.basis || '-', P, y + 24, F(400, 11), '#374151');
  text(m.weekly ? '주급 · 공제는 직원별 확인값' : '공제는 직원별로 확인한 값', P, y + 40, F(400, 11), '#6b7280');
  g.fillStyle = '#e6f2ef'; roundRect(g, W - P - 250, y - 12, 250, 56, 10); g.fill();
  text('지급 계좌 확인', W - P - 236, y + 8, F(800, 13), '#2f5d50');
  text(`${m.account.bank || '은행?'}  ·  ${m.account.holder || '예금주?'}  ·  끝 4자리 ${m.account.last4 || '????'}`, W - P - 236, y + 30, F(400, 12), '#1f2937');
  if (!m.ok) {
    g.save(); g.translate(W / 2, H / 2); g.rotate(-0.35); g.globalAlpha = 0.18;
    text('확인 필요 · 미확정', 0, 0, F(900, 64), '#c62828', 'center'); g.restore();
  }
  return c;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function showSheet(id) {
  const run = runOf(id), e = empById(run.empId) || {};
  const m = sheetModel(run, e);
  const cv = drawSheet(m);
  const box = document.createElement('div');
  box.id = 'evmodal';
  box.innerHTML = `<div class="evbox"><div class="row-h"><b>정산표 미리보기 ${m.ok ? '' : '— 미확정 (확인 필요)'}</b><span><button class="sm primary" id="pngsave" ${m.ok ? '' : 'disabled title="급여 확정 후 저장할 수 있습니다"'}>PNG 저장</button> <button class="sm" id="evclose">닫기</button></span></div>
    <div class="hint">장부에서 확정한 금액을 그대로 그린 그림입니다. PNG 저장은 그림 파일만 저장합니다 (송금·카톡 보내기·지급 완료는 하지 않음).</div><div class="sheetwrap"></div></div>`;
  box.querySelector('.sheetwrap').appendChild(cv);
  cv.style.maxWidth = '100%';
  document.body.appendChild(box);
  box.addEventListener('click', ev => {
    if (ev.target === box || ev.target.id === 'evclose') box.remove();
    if (ev.target.id === 'pngsave' && m.ok) cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `정산표_${m.name}_${(run.payDate || '').slice(0, 7) || run.id}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, 'image/png');
  });
  return { model: m, canvas: cv };
}

// ───── 월 마감 화면 ─────
export function closeSummary(M, ym) {
  const end = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const runs = live('payruns').filter(r => r.status === 'confirmed' && r.payDate && ymOf(r.payDate) === ym);
  let conf = 0, paid = 0, remain = 0;
  for (const r of runs) { const ps = payState(M, r, empById(r.empId)); conf += r.net; paid += ps.paid || 0; remain += ps.remain || 0; }
  const unconfirmed = employees().filter(e => e.kind !== 'weekly' && runOf(runIdMonthly(e.id, ym))?.status !== 'confirmed').map(e => e.name);
  const carried = live('payruns').filter(r => r.status === 'confirmed' && r.payDate && r.payDate < `${ym}-01`).map(r => ({ r, ps: payState(M, r, empById(r.empId)) })).filter(x => x.ps.remain > 0);
  const labor = laborByMonth()[ym] || 0;
  // 급여 현금 출금: 통장에서 대조된 급여 이체를 "이체한 달"에 한 번만
  const seen = new Set();
  let cashSalary = 0;
  for (const r of live('payruns').filter(r => r.status === 'confirmed')) {
    for (const t of payState(M, r, empById(r.empId)).txs || []) if (ymOf(t.date) === ym && !seen.has(t.id)) { seen.add(t.id); cashSalary += t.out; }
  }
  const inv = M.inv.list.filter(i => i.wdate <= end && M.inv.st[i.id].remain > 0);
  const recv = inv.filter(i => i.kind === 'sales'), pay = inv.filter(i => i.kind === 'purchase');
  const occ = occurrences(S(), M, `${ym}-01`, end < todayStr() ? end : todayStr()).filter(o => ymOf(o.date || '') === ym);
  const autoMissing = occ.filter(o => o.kind === 'out' && o.pay !== 'direct' && !o.done && o.chk);
  const need = end < todayStr() ? end : addDays(todayStr(), -1);
  const gaps = M.accounts.map(a => ({ a, last: lastCovered(M, a.id) })).filter(x => x.last && x.last < need); // 자료를 쓰는 통장만 (아예 안 쓰는 통장은 제외)
  const breaks = M.breaks.filter(b => ymOf(b.cur.date) === ym);
  return { conf, paid, remain, unconfirmed, carried, labor, cashSalary, recv, pay, autoMissing, gaps, breaks };
}

export function closeView(M) {
  const ym = pui.closeYm, c = closeOf(ym), x = closeSummary(M, ym);
  const sum = a => a.reduce((s, i) => s + M.inv.st[i.id].remain, 0);
  const logs = live('audit').filter(a => a.ym === ym).sort((a, b) => (a.at < b.at ? 1 : -1));
  const kv = (l, v, bad) => `<div class="kv"><span>${l}</span><b class="${bad ? 'red' : ''}">${v}</b></div>`;
  return `<h1>월 마감</h1>
    <div class="filters"><label class="inl">마감할 달 <input type="month" value="${ym}" data-chg="clYm"></label>
      ${c ? `${tag(`마감됨 · ${c.at} · ${c.by}`, 'green')} <button class="danger" data-act="clOpen">마감 해제</button>` : `<button class="primary" data-act="clDo">월 마감</button>`}</div>
    <div class="two">
      <section class="card"><h2>급여</h2>
        ${kv('급여 확정액 (이 달 지급분)', won(x.conf) + '원')}${kv('실제 지급 (확인·대조)', won(x.paid) + '원')}${kv('남은 금액', won(x.remain) + '원', x.remain > 0)}
        ${kv('미확정 직원', x.unconfirmed.length ? x.unconfirmed.map(esc).join(', ') : '없음', x.unconfirmed.length)}
        ${kv('인건비 (근무한 달 기준)', won(x.labor) + '원')}${kv('급여 현금 출금 (이체한 달 기준)', won(x.cashSalary) + '원')}
        ${x.carried.length ? `<div class="hint">이월 미지급 (원래 귀속월·지급예정일·잔액 유지): ${x.carried.map(({ r, ps }) => `${esc(empById(r.empId)?.name || '')} ${fmtMD(r.payDate)} 잔액 ${won(ps.remain)}`).join(' · ')}</div>` : ''}</section>
      <section class="card"><h2>확인할 것</h2>
        ${kv('미수금', `${x.recv.length}건 · ${won(sum(x.recv))}원`, x.recv.length)}${kv('미지급', `${x.pay.length}건 · ${won(sum(x.pay))}원`, x.pay.length)}
        ${kv('자동출금 미확인', `${x.autoMissing.length}건`, x.autoMissing.length)}
        ${kv('은행 자료 누락', x.gaps.length ? x.gaps.map(g => `${esc(g.a.name)} ${g.last ? fmtMD(g.last) + '까지' : '자료 없음'}`).join(' · ') : '없음', x.gaps.length)}
        ${kv('잔액 차이', `${x.breaks.length}곳`, x.breaks.length)}</section>
    </div>
    <section class="card"><h2>마감·해제 기록</h2>${logs.length ? `<table class="tbl"><thead><tr><th>시각</th><th>작업자</th><th>작업</th><th>사유</th><th>변경 전 → 후</th></tr></thead><tbody>${logs.map(a => `<tr><td class="nowrap">${esc(a.at)}</td><td>${esc(a.by)}</td><td>${{ close: '월 마감', reopen: '마감 해제', edit: '마감 달 수정' }[a.action] || esc(a.action)}</td><td>${esc(a.reason || '')}</td><td class="wrap muted s">${esc(JSON.stringify(a.before))} → ${esc(JSON.stringify(a.after))}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">기록이 없습니다.</div>'}
    <div class="hint">마감하면 그 달의 급여·비용·예정 항목을 고칠 수 없습니다 (PC·핸드폰 같은 상태). 은행 자료는 사실이라 계속 넣을 수 있습니다. 이 기기 이름: ${esc(deviceName())}</div></section>`;
}

// ───── 동작 ─────
async function loadCal(e, from, to) {
  if (!e.calId) throw new Error('직원 관리에서 이 직원의 출근 캘린더를 먼저 고르세요');
  const evs = await drive.calendar.events(e.calId, from, to);
  const kw = normName(e.calKeyword || '');
  return eventsToDays(kw ? evs.filter(x => normName((x.summary || '') + ' ' + (x.description || '')).includes(kw)) : evs, from, to);
}
function sameDays(a, b) { const k = x => (x || []).filter(d => d.on !== false).map(d => d.date + d.kind + (d.amount || '')).join('|'); return k(a) === k(b); }

export function extendPayUI({ ACT, CHG }) {
  Object.assign(ACT, {
    pyTab: el => { pui.tab = el.dataset.k; pui.sel = ''; render(); },
    pySel: el => { pui.sel = el.dataset.id; render(); },
    pyEmpAdd: () => {
      const name = prompt('직원 이름'); if (!name || !name.trim()) return;
      const k = prompt('계산 기준: 1 = 임금대장(월급, 16일)  2 = 출근 × 일당 (월 정산, 16일)  3 = 출근 × 일당 (주급)', '1');
      const kind = k === '2' ? 'monthlyDaily' : k === '3' ? 'weekly' : 'ledger';
      // 월 정산 직원 기본 일당: 평일 140,000 / 토·일·휴일 210,000 (화면에서 바꿀 수 있음). 주급 직원은 기본값 없음 (따로 정함)
      const rates = kind === 'monthlyDaily' ? { weekday: 140000, weekend: 210000 } : {};
      put('employees', { id: 'emp_' + uid(''), name: name.trim(), kind, rates, deduct: {}, bank: '', holder: '', last4: '', acct: { status: 'unverified', history: [] }, active: true, order: live('employees').length + 1, calId: '', calKeyword: '' });
      commit('emp');
    },
    pyEmpActive: el => { const e = empById(el.dataset.id) || S().employees[el.dataset.id]; patch('employees', e.id, { active: e.active === false }); commit('emp'); },
    pyAcctSave: el => {
      const id = el.dataset.id, v = k => document.getElementById(`ac-${k}-${id}`).value.trim();
      const last4 = v('l');
      if (last4 && !/^\d{4}$/.test(last4)) { toast('계좌는 끝 4자리 숫자만 넣어주세요 (전체 번호는 저장하지 않습니다)'); return; }
      const before = S().employees[id];
      setAccount(id, { bank: v('b'), holder: v('h'), last4 });
      commit('emp');
      if (before.last4 !== last4 || before.bank !== v('b') || before.holder !== v('h')) toast('계좌가 바뀌어 "확인 전"이 됐습니다. 맞으면 [계좌 확인]을 누르세요');
    },
    pyAcctOk: el => { if (!confirm('은행·예금주·끝 4자리를 직원에게 직접 확인하셨나요? 확인하면 "이체 준비 완료"가 됩니다.')) return; if (confirmAccount(el.dataset.id)) { commit('emp'); } else toast('은행·예금주·끝 4자리를 모두 넣어주세요'); },
    pyCalConnect: async () => {
      try { await drive.calendar.connect(); pui.cals = await drive.calendar.list(); toast('구글 캘린더를 읽기 전용으로 연결했습니다. 직원마다 출근 캘린더를 고르세요'); }
      catch (e) { toast(e.message === 'API_OFF' ? '구글 클라우드에서 Calendar API를 켜야 합니다 (설정 안내 참고)' : '캘린더 연결 실패: ' + e.message); if (e.message === 'API_OFF') window.open(drive.CAL_API_URL, '_blank', 'noopener'); }
      render();
    },
    pyCalList: async () => { try { pui.cals = await drive.calendar.list(); } catch (e) { toast('캘린더 목록을 읽지 못했습니다: ' + e.message); } render(); },
    pyCal: async el => {
      const e = empById(el.dataset.emp), id = el.dataset.id;
      const run = runOf(id);
      const per = e.kind === 'weekly' ? (({ from, to }) => ({ from, to }))(weekDays(el.dataset.mon)) : monthlyPeriod(pui.ym);
      if (closedBlock(run?.payDate || (e.kind === 'weekly' ? weekDays(el.dataset.mon).sun : `${pui.ym}-16`))) return;
      try {
        if (!drive.calendar.connected()) await drive.calendar.connect();
        const days = await loadCal(e, per.from, per.to);
        if (run && run.status === 'confirmed') {
          if (sameDays(run.days, days)) { toast('캘린더 출근 기록이 확정 내용과 같습니다'); return; }
          const tmp = { ...run, days, daysChecked: true };
          const c = calcDaily(e, tmp);
          patch('payruns', id, { pending: { days, net: c.net, gross: c.gross, deduction: c.deduction, reason: '확정 후 캘린더 출근 기록이 달라짐 (추가 근무 등)' } });
          commit('pay'); pui.sel = id; toast('확정 후 출근 기록이 달라졌습니다. 변경 전후·차액을 확인하세요'); return;
        }
        put('payruns', { ...(run || {}), id, empId: e.id, type: e.kind === 'weekly' ? 'weekly' : 'monthly', weekOf: e.kind === 'weekly' ? el.dataset.mon : '', payYm: e.kind === 'weekly' ? '' : pui.ym, period: per, payDate: run?.payDate || (e.kind === 'weekly' ? '' : `${pui.ym}-16`), days, daysChecked: false, status: 'draft', src: { kind: 'calendar', calId: e.calId, at: nowTs() } });
        commit('pay'); pui.sel = id; toast(`출근 일정 ${days.length}일을 불러왔습니다. 실제 출근일을 확인하세요`);
      } catch (err) { toast(err.message === 'CAL_LOGIN' ? '구글 캘린더 연결이 필요합니다 (직원 관리 → 구글 캘린더 연결)' : err.message === 'API_OFF' ? 'Calendar API가 꺼져 있습니다' : '출근 기록을 읽지 못했습니다: ' + err.message); }
    },
    pyDayAdd: el => {
      const run = runOf(el.dataset.id); const d = prompt('출근한 날짜 (예: 2026-11-07)', run.period?.from || ''); if (!d) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || (run.period && (d < run.period.from || d > run.period.to))) { toast('집계 기간 안의 날짜를 2026-11-07처럼 넣어주세요'); return; }
      if ((run.days || []).some(x => x.date === d)) { toast('이미 있는 날짜입니다 (같은 날은 1일로 셉니다)'); return; }
      patch('payruns', run.id, { days: [...(run.days || []), { date: d, kind: defaultDayKind(d), on: true, events: [] }].sort((a, b) => (a.date < b.date ? -1 : 1)), daysChecked: false }); commit('pay');
    },
    pyDaysOk: el => { patch('payruns', el.dataset.id, { daysChecked: true }); commit('pay'); },
    pyConfirm: el => {
      const run = runOf(el.dataset.id), e = empById(run.empId);
      if (closedBlock(run.payDate || run.payYm)) return;
      if (e.kind === 'ledger') {
        if (!(run.net > 0)) { toast('차인지급액이 없어 확정할 수 없습니다'); return; }
        if (!run.attrYm) { toast('귀속월이 비어 있습니다'); return; }
        patch('payruns', run.id, { status: 'confirmed', confirmedAt: nowTs() });
      } else {
        const c = calcDaily(e, run);
        if (c.issues.length) { toast('확인 필요: ' + c.issues.join(', ')); return; }
        patch('payruns', run.id, { status: 'confirmed', confirmedAt: nowTs(), gross: c.gross, deduction: c.deduction, net: c.net, deductMode: e.deduct.mode, days: c.lines, rates: { ...e.rates } });
      }
      commit('pay'); toast('급여를 확정했습니다. 지급 예정 합계에 들어갑니다');
    },
    pyPendApply: el => {
      const run = runOf(el.dataset.id); if (closedBlock(run.payDate || run.payYm)) return;
      const p = run.pending, e = empById(run.empId);
      const ps = payState(model(), run, e);
      if (!confirm(`변경 반영: ${won(run.net)} → ${won(p.net)} (차액 ${won(p.net - run.net)})${ps.paid ? `\n이미 지급한 ${won(ps.paid)}원은 그대로 두고 남은 금액만 바뀝니다.` : ''}`)) return;
      patch('payruns', run.id, { net: p.net, gross: p.gross, deduction: p.deduction, days: p.days ? calcDaily(e, { ...run, days: p.days, daysChecked: true }).lines : run.days, src: p.src || run.src, pending: null, revisions: [...(run.revisions || []), { at: nowTs(), before: run.net, after: p.net, reason: p.reason || '' }] });
      commit('pay');
    },
    pyPendDrop: el => { patch('payruns', el.dataset.id, { pending: null }); commit('pay'); },
    pyDate: el => {
      const e = empById(el.dataset.emp), id = el.dataset.id, run = runOf(id);
      const cur = run?.payDate || `${pui.ym}-16`;
      const d = prompt(`${e.name} ${fmtYM(pui.ym)} 지급일 (이번 달만 바뀝니다)`, cur); if (!d) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('2026-11-16 처럼 넣어주세요'); return; }
      if (closedBlock(cur) || closedBlock(d)) return;
      if (run) patch('payruns', id, { payDate: d, payDateChanged: d !== `${pui.ym}-16` });
      else put('payruns', { id, empId: e.id, type: 'monthly', payYm: pui.ym, payDate: d, payDateChanged: d !== `${pui.ym}-16`, status: 'waiting', period: e.kind === 'monthlyDaily' ? monthlyPeriod(pui.ym) : null, days: [] });
      commit('pay');
    },
    pyPaid: el => {
      const run = runOf(el.dataset.id), e = empById(run.empId), ps = payState(model(), run, e);
      if (closedBlock(run.payDate)) return;
      const v = prompt(`${e.name} 지급한 금액 (이번에 보낸 금액, 남은 금액 ${won(ps.remain)}원)`, won(ps.remain)); if (v === null) return;
      const n = parseWonInput(v);
      if (!(n > 0) || n > ps.remain) { toast(`1 ~ ${won(ps.remain)}원 사이로 넣어주세요`); return; }
      patch('payruns', run.id, { paid: [...(run.paid || []), { at: nowTs(), amount: n, by: 'user' }] }); commit('pay');
      toast(n < ps.remain ? `일부 지급 ${won(n)}원 · 남은 ${won(ps.remain - n)}원` : '지급 확인 (사용자). 통장 자료가 들어오면 은행 대조 완료로 바뀝니다');
    },
    pyPaidUndo: el => { const run = runOf(el.dataset.id); if (closedBlock(run.payDate)) return; if (confirm('지급 확인 기록을 지울까요?')) { patch('payruns', run.id, { paid: [] }); commit('pay'); } },
    pyPreview: el => { showSheet(el.dataset.id); },
    pyLedgerDo: () => {
      const L = pui.ledger; if (!L || L.error || L.dupFile) return;
      const attrYm = document.getElementById('wl-attr').value, payDate = document.getElementById('wl-pay').value;
      if (!attrYm) { toast('귀속월을 골라주세요 (파일에서 못 읽음)'); return; }
      if (!payDate) { toast('지급일을 넣어주세요'); return; }
      const payYm = ymOf(payDate);
      if (closedBlock(payDate)) return;
      const emps = employees();
      let added = 0, revised = 0, same = 0;
      for (const x of L.list) {
        const cands = emps.filter(e => normName(e.name) === normName(x.name));
        if (cands.length !== 1 || cands[0].kind !== 'ledger') continue;
        const e = cands[0], id = runIdMonthly(e.id, payYm), run = runOf(id);
        const src = { kind: 'ledger', file: L.file, sha: L.sha, row: x.row };
        if (run && run.status === 'confirmed') {
          if (run.net === x.net) { same++; continue; }
          patch('payruns', id, { pending: { net: x.net, gross: x.gross, deduction: x.deduction, src, reason: `임금대장 수정본 (${L.file})` } }); revised++;
        } else {
          put('payruns', { ...(run || {}), id, empId: e.id, type: 'monthly', payYm, attrYm, payDate: run?.payDateChanged ? run.payDate : payDate, gross: x.gross, deduction: x.deduction, net: x.net, status: 'draft', src }); added++;
        }
      }
      put('imports', { id: 'wage_' + L.sha.slice(0, 20), at: nowTs(), file: L.file, type: 'wage', sha: L.sha, attrYm, from: payDate, to: payDate, rows: L.list.length, added, dup: same, updated: revised, ok: true });
      pui.ledger = null; commit('pay');
      toast(`임금대장: ${added}명 가져옴 (확정은 [급여 확정]으로)${revised ? ` · 확정된 ${revised}명은 변경 자료로 따로 표시` : ''}${same ? ` · 같은 금액 ${same}명` : ''}`);
    },
    pyLedgerCancel: () => { pui.ledger = null; render(); },
    clDo: () => {
      const ym = pui.closeYm, M = model(), x = closeSummary(M, ym);
      const warn = [x.unconfirmed.length && `미확정 급여 ${x.unconfirmed.length}명`, x.remain && `남은 급여 ${won(x.remain)}원`, x.recv.length && `미수 ${x.recv.length}건`, x.pay.length && `미지급 ${x.pay.length}건`, x.autoMissing.length && `자동출금 미확인 ${x.autoMissing.length}건`, x.gaps.length && `은행 자료 누락 ${x.gaps.length}곳`, x.breaks.length && `잔액 차이 ${x.breaks.length}곳`].filter(Boolean);
      if (!confirm(`${fmtYM(ym)}을 마감할까요?${warn.length ? '\n\n남은 확인 사항:\n- ' + warn.join('\n- ') : ''}\n\n마감하면 이 달 급여·비용·예정 항목을 고칠 수 없습니다.`)) return;
      closeMonth(ym, { conf: x.conf, paid: x.paid, remain: x.remain, labor: x.labor });
      commit('close'); toast(`${fmtYM(ym)} 마감했습니다`);
    },
    clOpen: () => {
      const ym = pui.closeYm;
      const reason = prompt(`${fmtYM(ym)} 마감을 해제하는 사유 (기록에 남습니다)`);
      if (reason === null) return;
      if (!reason.trim()) { toast('사유를 넣어야 해제할 수 있습니다'); return; }
      reopenMonth(ym, reason); commit('close'); toast('마감을 해제했습니다 (기록 남김)');
    },
  });
  Object.assign(CHG, {
    pyYm: el => { pui.ym = el.value || thisYm(); pui.sel = ''; render(); },
    clYm: el => { pui.closeYm = el.value || addMonths(thisYm(), -1); render(); },
    pyEmp: el => { patch('employees', el.dataset.id, { [el.dataset.f]: el.value.trim() }); commit('emp'); },
    pyRate: el => { const e = empById(el.dataset.id); const n = el.value.trim() === '' ? null : parseWonInput(el.value); if (n != null && !(n > 0)) { toast('금액을 숫자로 넣어주세요'); render(); return; } patch('employees', e.id, { rates: { ...(e.rates || {}), [el.dataset.f]: n } }); commit('emp'); },
    pyDed: el => {
      const e = empById(el.dataset.id); let d = { mode: el.value, confirmed: false };
      if (el.value === 'fixed') { const v = prompt('공제 금액 (원)', ''); const n = parseWonInput(v || ''); if (!(n >= 0)) { toast('금액을 숫자로 넣어주세요'); render(); return; } d.amount = n; }
      patch('employees', e.id, { deduct: d }); commit('emp'); toast('공제 방식을 바꿨습니다. 맞으면 "확인함"을 체크하세요');
    },
    pyDedOk: el => { const e = empById(el.dataset.id); if (el.checked && !e.deduct?.mode) { toast('공제 방식을 먼저 고르세요'); render(); return; } patch('employees', e.id, { deduct: { ...(e.deduct || {}), confirmed: el.checked } }); commit('emp'); },
    pyWeekDay: el => {
      const e = empById(el.dataset.emp), id = el.dataset.id, run = runOf(id), d = el.value;
      if (dow(d) !== 0 && dow(d) !== 6) return; // 월요일 등은 선택 불가
      if (closedBlock(d) || (run?.payDate && closedBlock(run.payDate))) { render(); return; }
      if (run) patch('payruns', id, { payDate: d });
      else put('payruns', { id, empId: e.id, type: 'weekly', weekOf: el.dataset.mon, payDate: d, status: 'waiting', period: (({ from, to }) => ({ from, to }))(weekDays(el.dataset.mon)), days: [] });
      commit('pay');
    },
    pyDayOn: el => { const run = runOf(el.dataset.id); const days = [...run.days]; days[+el.dataset.i] = { ...days[+el.dataset.i], on: el.checked }; patch('payruns', run.id, { days, daysChecked: false }); commit('pay'); },
    pyDayKind: el => { const run = runOf(el.dataset.id); const days = [...run.days]; const cur = days[+el.dataset.i]; days[+el.dataset.i] = { ...cur, kind: el.value, halfOf: el.value === 'half' ? (defaultDayKind(cur.date) === 'weekday' ? 'weekday' : 'weekend') : undefined, amount: el.value === 'custom' ? cur.amount : undefined }; patch('payruns', run.id, { days, daysChecked: false }); commit('pay'); },
    pyDayAmt: el => { const run = runOf(el.dataset.id); const n = parseWonInput(el.value); if (!(n > 0)) { toast('금액을 숫자로'); return; } const days = [...run.days]; days[+el.dataset.i] = { ...days[+el.dataset.i], amount: n }; patch('payruns', run.id, { days, daysChecked: false }); commit('pay'); },
    pyDayNote: el => { const run = runOf(el.dataset.id); const days = [...run.days]; days[+el.dataset.i] = { ...days[+el.dataset.i], note: el.value.trim() }; patch('payruns', run.id, { days }); commit('pay'); },
    pyLedger: async el => {
      const f = el.files[0]; el.value = ''; if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        const sha = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
        if (live('imports').some(i => i.type === 'wage' && i.sha === sha)) { pui.ledger = { file: f.name, dupFile: true }; render(); return; }
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        let res = null;
        for (const sn of wb.SheetNames) { const r = parseWageLedger(XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' })); if (!r.error) { res = r; break; } res = r; }
        pui.ledger = { ...res, file: f.name, sha };
      } catch (e) { pui.ledger = { error: '파일을 읽지 못했습니다: ' + e.message }; }
      render();
    },
  });
}
export { showSheet };
