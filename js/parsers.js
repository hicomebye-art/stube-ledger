// 엑셀 읽기: 은행 거래내역(수협·농협·기타)과 홈택스 전자세금계산서 목록
// 칸 위치가 아니라 "칸 이름"으로 찾기 때문에 은행이 칸 순서를 바꿔도 대부분 읽힙니다.
import { toInt, parseDateTime } from './util.js';

const txt = v => String(v ?? '').trim();
const key = v => txt(v).replace(/\s+/g, '');

export function parseFile(buf, fileName) {
  if (typeof XLSX === 'undefined') return { error: '엑셀 읽기 모듈을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  let wb;
  try {
    wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/password|encrypt|ECMA-376|CFB/i.test(msg)) return { error: 'ENCRYPTED' };
    return { error: '파일을 읽을 수 없습니다: ' + msg };
  }
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '', blankrows: true });
    const r = detectAndParse(rows, fileName);
    if (r) return r;
  }
  return { error: '은행 거래내역이나 홈택스 세금계산서 형식을 찾지 못했습니다.' };
}

function detectAndParse(rows, fileName) {
  const lim = Math.min(rows.length, 40);
  for (let i = 0; i < lim; i++) {
    const ks = (rows[i] || []).map(key);
    if (ks.includes('작성일자') && ks.includes('승인번호') && ks.includes('공급가액')) return parseHometax(rows, i, fileName);
    const has = re => ks.some(k => re.test(k));
    if (has(/^(거래일시|거래일자|일자|거래일|날짜|일시)$/) && has(/잔액/) && (has(/^입금/) || has(/^거래금액$/))) {
      return parseBank(rows, i, fileName);
    }
  }
  return null;
}

function findCol(ks, names, exclude = []) {
  for (const name of names) {
    const i = ks.findIndex((k, idx) => !exclude.includes(idx) && (name instanceof RegExp ? name.test(k) : k === name));
    if (i >= 0) return i;
  }
  return -1;
}

// 머리말 영역에서 "라벨 → 오른쪽 첫 값" 찾기 (예: 입금합계액 690,877,407 원)
function labelValue(rows, upto, re) {
  for (let r = 0; r < upto; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (re.test(key(row[c]))) {
        for (let d = c + 1; d < row.length; d++) if (txt(row[d]) !== '') return row[d];
      }
    }
  }
  return null;
}

function parseBank(rows, hi, fileName) {
  const ks = rows[hi].map(key);
  const dateI = findCol(ks, ['거래일시', '거래일자', '일자', '거래일', '날짜', '일시']);
  const timeI = findCol(ks, ['거래시간', '시간', '시각']);
  const inI = findCol(ks, ['입금', '입금금액', '입금액', '맡기신금액', /^입금\(/]);
  const outI = findCol(ks, ['출금', '출금금액', '출금액', '찾으신금액', /^출금\(/]);
  const amtI = findCol(ks, ['거래금액', '금액']);
  const typeI = findCol(ks, ['구분', '거래구분', '입출금구분', '거래유형']);
  const balI = findCol(ks, ['거래후잔액', '잔액', /잔액/]);
  const descI = findCol(ks, ['거래기록사항', '보낸분/받는분', '받는분/보낸분', '적요', '기재내용', '내용', '거래처', '상대방', '거래내용']);
  const methodI = findCol(ks, ['회차/방법', '거래내용', '거래구분', '구분', '거래유형', '거래종류'], [descI]);
  const branchI = findCol(ks, ['입출금은행', '거래점', '취급점']);
  const memoI = findCol(ks, ['거래메모', '메모']);

  if (dateI < 0 || balI < 0 || (inI < 0 && outI < 0 && amtI < 0)) return { error: '은행 파일의 칸 이름을 알아보지 못했습니다.' };

  let bank = '';
  if (ks.includes('보낸분/받는분') && ks.includes('회차/방법')) bank = 'suhyup';
  else if (ks.includes('거래기록사항') && ks.includes('거래후잔액')) bank = 'nh';
  else if (/수협/.test(fileName)) bank = 'suhyup';
  else if (/농협|NH/i.test(fileName)) bank = 'nh';
  else if (/카카오/.test(fileName)) bank = 'kakao';
  else if (/우체국|우정/.test(fileName)) bank = 'post';

  const list = [], problems = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const dt = parseDateTime(row[dateI]);
    if (!dt) continue;
    if (timeI >= 0 && !dt.time) {
      const tm = txt(row[timeI]).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (tm) dt.time = `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}`;
    }
    try {
      let inA = 0, outA = 0;
      if (inI >= 0 || outI >= 0) {
        inA = inI >= 0 ? toInt(row[inI]) : 0;
        outA = outI >= 0 ? toInt(row[outI]) : 0;
      } else {
        const a = toInt(row[amtI]);
        const ty = txt(row[typeI]);
        if (/출금|지급|출/.test(ty) || a < 0) outA = Math.abs(a); else inA = a;
      }
      const bal = toInt(row[balI]);
      const method = txt(row[methodI]).replace(/^\d+\//, '').replace(/\s+/g, '');
      let desc = txt(row[descI]);
      if (!desc) desc = method;
      list.push({ date: dt.date, time: dt.time, in: inA, out: outA, bal, desc, method, branch: txt(row[branchI]), memo: txt(row[memoI]), row: r + 1 });
    } catch (e) {
      problems.push(`${r + 1}행: ${e.message}`);
    }
  }
  if (!list.length) return { error: '거래 행을 찾지 못했습니다.' };

  // 시간 순서로 정렬 (은행 파일은 보통 최신이 위)
  const ts = x => x.date + ' ' + (x.time || '00:00:00');
  if (ts(list[0]) > ts(list[list.length - 1])) list.reverse();

  // 파일 안에서 잔액 연결 확인: 앞 잔액 + 입금 - 출금 = 이번 잔액
  const breaks = [];
  for (let i = 1; i < list.length; i++) {
    const exp = list[i - 1].bal + list[i].in - list[i].out;
    if (exp !== list[i].bal) breaks.push({ i, row: list[i].row, expected: exp, actual: list[i].bal });
  }

  const sumIn = list.reduce((s, x) => s + x.in, 0);
  const sumOut = list.reduce((s, x) => s + x.out, 0);
  const checks = [];
  checks.push({ label: '잔액 연결', ok: breaks.length === 0, detail: breaks.length ? `${breaks.length}곳에서 잔액이 이어지지 않음` : `${list.length}건 모두 앞뒤 잔액이 맞음` });
  const dIn = labelValue(rows, hi, /^입금합계액?$/), dOut = labelValue(rows, hi, /^출금합계액?$/);
  if (dIn !== null) { const v = toIntSafe(dIn); checks.push({ label: '입금 합계', ok: v === sumIn, detail: `은행 ${fmt(v)} / 계산 ${fmt(sumIn)}` }); }
  if (dOut !== null) { const v = toIntSafe(dOut); checks.push({ label: '출금 합계', ok: v === sumOut, detail: `은행 ${fmt(v)} / 계산 ${fmt(sumOut)}` }); }
  const dBal = labelValue(rows, hi, /^(통장잔액|최종금액|현재잔액|잔액)$/);
  if (dBal !== null) { const v = toIntSafe(dBal); const last = list[list.length - 1].bal; checks.push({ label: '최종 잔액', ok: v === last, detail: `은행 ${fmt(v)} / 마지막 거래 ${fmt(last)}` }); }
  const cntCell = rows.slice(0, hi + 1).flat().map(txt).find(t => /총건수/.test(t));
  if (cntCell) { const m = cntCell.match(/(\d+)/); if (m) checks.push({ label: '건수', ok: +m[1] === list.length, detail: `은행 ${m[1]}건 / 읽은 ${list.length}건` }); }
  if (problems.length) checks.push({ label: '읽기 오류', ok: false, detail: problems.slice(0, 3).join(', ') });

  const holder = txt(labelValue(rows, hi, /^예금주명?$/) || '');
  return { type: 'bank', bank, holder, rows: list, breaks, checks, problems, from: list[0].date, to: list[list.length - 1].date };
}

// 이메일 도메인 → 회사 이름 단서 (예: ...@abcpower.com → "abcpower" = 통장의 영문 입금자명 "ABC POWER")
const WEBMAIL = /^(naver|daum|hanmail|gmail|nate|kakao|hotmail|outlook|yahoo|korea|hanmir|empas|paran|chol|dreamwiz|lycos|live|icloud|me|msn|bill36524|smartbill|hiworks|unipass|esero|hometax|wehago|bizforms|webcash|sendbill|nicebill|ecount)$/;
function mailDomains(mails) {
  const out = new Set();
  for (const m of mails) {
    const d = (m.split('@')[1] || '').toLowerCase();
    const label = d.split('.')[0];
    if (label && label.length >= 4 && !WEBMAIL.test(label)) out.add(label);
  }
  return [...out];
}

function toIntSafe(v) { try { return toInt(String(v).replace(/[^\d-]/g, '')); } catch { return NaN; } }
function fmt(n) { return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '?'; }

function parseHometax(rows, hi, fileName) {
  const ks = rows[hi].map(key);
  const idx = (name, after = -1) => ks.findIndex((k, i) => i > after && k === name);
  const supBiz = idx('공급자사업자등록번호'), buyBiz = idx('공급받는자사업자등록번호');
  const c = {
    wdate: idx('작성일자'), appr: idx('승인번호'), idate: idx('발급일자'),
    supBiz, supName: idx('상호', supBiz), buyBiz, buyName: idx('상호', buyBiz),
    total: idx('합계금액'), supply: idx('공급가액'), tax: idx('세액'),
    cls: idx('전자세금계산서분류'), typ: idx('전자세금계산서종류'), note: idx('비고'),
    rc: idx('영수/청구구분'), item: idx('품목명'),
    supRep: idx('대표자명', supBiz), buyRep: idx('대표자명', buyBiz),
    supMail: idx('공급자이메일'), buyMail1: idx('공급받는자이메일1'), buyMail2: idx('공급받는자이메일2'),
  };
  let kind = '';
  for (let i = 0; i < hi && !kind; i++) {
    const t = (rows[i] || []).map(txt).join(' ');
    if (/매출/.test(t) && /세금계산서/.test(t)) kind = 'sales';
    else if (/매입/.test(t) && /세금계산서/.test(t)) kind = 'purchase';
  }
  if (!kind) { if (/매출/.test(fileName)) kind = 'sales'; else if (/매입/.test(fileName)) kind = 'purchase'; }
  if (!kind) return { error: '매출인지 매입인지 알 수 없는 세금계산서 파일입니다.' };

  const list = [], problems = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const appr = txt(row[c.appr]);
    if (!appr) continue;
    const wd = parseDateTime(row[c.wdate]);
    if (!wd) { problems.push(`${r + 1}행: 작성일자 오류`); continue; }
    try {
      const total = toInt(row[c.total]), supply = toInt(row[c.supply]), tax = toInt(row[c.tax]);
      if (supply + tax !== total) problems.push(`${r + 1}행: 공급가액+세액이 합계와 다름`);
      const sales = kind === 'sales';
      const note = txt(row[c.note]);
      const om = note.match(/당초\s*승인번호\s*\(\s*([0-9A-Za-z-]+)\s*\)/);
      const rep = txt(row[sales ? c.buyRep : c.supRep]);
      const mails = (sales ? [row[c.buyMail1], row[c.buyMail2]] : [row[c.supMail]]).map(txt).filter(Boolean);
      list.push({
        id: appr, kind, wdate: wd.date, idate: (parseDateTime(row[c.idate]) || wd).date,
        biz: txt(row[sales ? c.buyBiz : c.supBiz]), name: txt(row[sales ? c.buyName : c.supName]) || rep, rep,
        dom: mailDomains(mails),
        total, supply, tax, cls: txt(row[c.cls]), typ: txt(row[c.typ]), note, rc: txt(row[c.rc]),
        item: txt(row[c.item]), orig: om ? om[1] : '',
      });
    } catch (e) {
      problems.push(`${r + 1}행: ${e.message}`);
    }
  }
  if (!list.length) return { error: '세금계산서 행을 찾지 못했습니다.' };

  const sum = k => list.reduce((s, x) => s + x[k], 0);
  const checks = [];
  const dTot = labelValue(rows, hi, /^총합계금액$/), dSup = labelValue(rows, hi, /^총공급가액$/), dTax = labelValue(rows, hi, /^총세액$/);
  if (dTot !== null) { const v = toIntSafe(dTot); checks.push({ label: '합계금액', ok: v === sum('total'), detail: `홈택스 ${fmt(v)} / 계산 ${fmt(sum('total'))}` }); }
  if (dSup !== null) { const v = toIntSafe(dSup); checks.push({ label: '공급가액', ok: v === sum('supply'), detail: `홈택스 ${fmt(v)} / 계산 ${fmt(sum('supply'))}` }); }
  if (dTax !== null) { const v = toIntSafe(dTax); checks.push({ label: '세액', ok: v === sum('tax'), detail: `홈택스 ${fmt(v)} / 계산 ${fmt(sum('tax'))}` }); }
  if (problems.length) checks.push({ label: '읽기 오류', ok: false, detail: problems.slice(0, 3).join(', ') });

  const dates = list.map(x => x.wdate).sort();
  return { type: 'invoice', kind, list, checks, problems, from: dates[0], to: dates[dates.length - 1] };
}
