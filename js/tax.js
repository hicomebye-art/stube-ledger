// 세무자료: 근로소득세·지방소득세(특별징수) 납부서 PDF → 세무 목록
// - 원본 PDF는 옮기거나 이름을 바꾸지 않고, 내용(글자)만 읽습니다. PDF 자체는 드라이브·외부로 올리지 않습니다.
// - 읽힌 값만 채웁니다. 금액·납부기한을 추정해서 넣지 않습니다. 못 읽었거나 파일명과 본문이 다르면 "확인 필요".
// - 같은 PDF(내용이 똑같음)는 다시 넣지 않습니다. 이름이 같은데 내용이 다른 수정본은 기존 건을 덮어쓰지 않고 따로 확인.
// - 가져왔다고 미납·납부완료로 단정하지 않습니다. 납부 상태는 은행 대조 또는 사용자 확인으로만 정합니다.
import { store, live, put, patch } from './store.js';
import { dayDiff, addDays } from './util.js';

export const TAX_KIND = { wage: '근로소득세', local: '지방소득세' };
const N = s => String(s || '').normalize('NFKC');
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export const ymLabel = s => (s ? `${s.slice(0, 4)}년 ${Number(s.slice(5, 7))}월` : '');
export const monthsLabel = d => (d.attrYm || d.payYm ? `${d.attrYm ? ymLabel(d.attrYm) + ' 귀속' : '귀속 ?'} / ${d.payYm ? (d.attrYm && d.payYm.slice(0, 4) === d.attrYm.slice(0, 4) ? Number(d.payYm.slice(5, 7)) + '월' : ymLabel(d.payYm)) + ' 지급' : '지급 ?'}` : '');

// 세목
function kindOf(t) {
  const s = N(t).replace(/\s+/g, '');
  const local = /지방소득세/.test(s);
  const wage = /근로소득세|근로소득|원천세|원천징수|갑종근로/.test(s);
  if (local && /특별징수|위택스|지방세|시·?군·?구|구청|시청/.test(s)) return 'local';
  if (wage && !local) return 'wage';
  if (local && !wage) return 'local';
  if (wage && local) return /국세|홈택스|세무서/.test(s) ? 'wage' : '';
  return '';
}

// 파일명에서: "2026년 9월 귀속", "10월 지급", "202609 귀속" 등
export function fromFileName(name) {
  const s = N(name).replace(/\.pdf$/i, '');
  const out = { kind: kindOf(s) };
  let m = s.match(/(20\d{2})\s*[년.\-_]?\s*(\d{1,2})\s*월?\s*귀속/) || s.match(/귀속\s*(20\d{2})\s*[년.\-_]?\s*(\d{1,2})/);
  if (m) out.attrYm = ym(m[1], m[2]);
  m = s.match(/(20\d{2})\s*[년.\-_]?\s*(\d{1,2})\s*월?\s*지급/) || s.match(/지급\s*(20\d{2})\s*[년.\-_]?\s*(\d{1,2})/);
  if (m) out.payYm = ym(m[1], m[2]);
  else if ((m = s.match(/(\d{1,2})\s*월\s*지급/)) && out.attrYm) {
    const am = Number(out.attrYm.slice(5)), pm = Number(m[1]), y = Number(out.attrYm.slice(0, 4));
    out.payYm = ym(pm < am ? y + 1 : y, pm);
  }
  return out;
}

const AMT = /(\d{1,3}(?:,\d{3})+|\d{4,12})\s*원?/;
function amountAfter(line, re) {
  const i = line.search(re);
  if (i < 0) return null;
  const m = line.slice(i).replace(re, '').match(AMT);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}
function dateIn(s) {
  const m = N(s).match(/(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/);
  if (!m) return '';
  const mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
}
function ymAfter(text, re) {
  const m = N(text).match(new RegExp(re.source + '\\s*(?:연월|년월|월)?\\s*[:：]?\\s*(20\\d{2})\\s*[년.\\-/]\\s*(\\d{1,2})'));
  return m ? ym(m[m.length - 2], m[m.length - 1]) : '';
}

// 본문 글자에서 읽기
// 홈택스 납부서는 금액 숫자를 한 칸씩 띄어 찍음 (예: "1 2 3 , 4 5 6") → "123,456"으로 붙임
const joinDigits = s => s.replace(/(\d)[ \t]+(?=[\d,])/g, '$1').replace(/,[ \t]+(?=\d)/g, ',');

export function parseTaxSlip(text, fileName = '') {
  const t = joinDigits(N(text));
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const body = { kind: kindOf(t), attrYm: ymAfter(t, /귀속/), payYm: ymAfter(t, /지급/) };
  // 납부기한
  let due = '';
  for (const l of lines) { if (/납\s*부\s*기\s*한|납\s*기\s*(일|내|한)/.test(l)) { due = dateIn(l.slice(l.search(/납\s*부\s*기\s*한|납\s*기/))); if (due) break; } }
  // 금액: 납기내 금액 → 납부할 세액/납부금액/합계 순. 서로 다른 값이 여러 개면 비워두고 확인 필요.
  const inDue = [], other = [];
  for (const l of lines) {
    if (/납\s*기\s*후/.test(l)) continue;
    let v = amountAfter(l, /납\s*기\s*내\s*(금액|세액)?/);
    if (v != null) { inDue.push(v); continue; }
    v = amountAfter(l, /(납부\s*할?\s*(세액|금액)\s*(합계|계)?|납부\s*총액|총\s*납부\s*(세액|금액)|납부\s*금액|세액\s*합계|합\s*계\s*(금액|세액)?)/);
    // 홈택스 원천세 납부서: "세목명 | 납부금액" 표의 "근로소득세(갑) 123,456" 줄과 "계 123,456" 줄
    if (v == null) v = amountAfter(l, /근로소득세\s*\(\s*갑\s*\)(?=\s*\d)/);
    if (v == null) v = amountAfter(l, /(?:^|\s)계(?=\s*\d)/);
    if (v != null) other.push(v);
  }
  const pick = arr => { const u = [...new Set(arr)]; return u.length === 1 ? u[0] : null; };
  let amount = pick(inDue);
  if (amount == null && !inDue.length) amount = pick(other);
  const eNo = (t.match(/전자\s*납부\s*번호\s*[:：]?\s*([\d-]{10,})/) || [])[1] || '';

  const fn = fromFileName(fileName);
  const d = {
    kind: body.kind || fn.kind || '',
    attrYm: body.attrYm || fn.attrYm || '',
    payYm: body.payYm || fn.payYm || '',
    amount, due, eNo,
  };
  const issues = [];
  if (!d.kind) issues.push('세목(근로소득세/지방소득세)을 못 읽음');
  if (!d.attrYm) issues.push('귀속월을 못 읽음');
  if (!d.payYm) issues.push('지급월을 못 읽음');
  if (amount == null) issues.push([...new Set([...inDue, ...other])].length > 1 ? '금액이 여러 개라 정하지 않음' : '납부금액을 못 읽음');
  if (!due) issues.push('납부기한을 못 읽음');
  if (body.kind && fn.kind && body.kind !== fn.kind) issues.push(`파일명(${TAX_KIND[fn.kind]})과 본문(${TAX_KIND[body.kind]}) 세목이 다름`);
  if (body.attrYm && fn.attrYm && body.attrYm !== fn.attrYm) issues.push(`파일명 귀속(${ymLabel(fn.attrYm)})과 본문 귀속(${ymLabel(body.attrYm)})이 다름`);
  if (body.payYm && fn.payYm && body.payYm !== fn.payYm) issues.push(`파일명 지급(${ymLabel(fn.payYm)})과 본문 지급(${ymLabel(body.payYm)})이 다름`);
  if (!t.trim()) issues.push('PDF에서 글자를 읽지 못함 (스캔 이미지일 수 있음)');
  return { ...d, issues, isSlip: !!d.kind && /납부|납입|고지/.test(t + fileName) };
}

// 가져오기: items = [{ name, path, size, modified, sha, text }]
// 결과: { added, dup, revisions, skipped, list }
export function importTaxDocs(items, nowTs) {
  const S = store.state;
  const bySha = new Map(live('taxdocs').map(d => [d.sha, d]));
  const res = { added: 0, dup: 0, revisions: 0, skipped: 0, skippedNames: [], ids: [] };
  for (const it of items) {
    if (bySha.has(it.sha)) { res.dup++; continue; }
    const p = parseTaxSlip(it.text, it.name);
    if (!p.isSlip) { res.skipped++; res.skippedNames.push(it.name); continue; }
    // 파일은 다르지만(다시 저장·다시 받은 PDF) 세목·귀속·지급·금액·기한이 모두 같으면 같은 납부서로 봄
    const ckey = x => [x.kind, x.attrYm, x.payYm, x.amount, x.due].join('|');
    if (p.kind && p.attrYm && p.payYm && p.amount != null && live('taxdocs').some(d => d.status !== 'ignored' && ckey(d) === ckey(p))) { res.dup++; continue; }
    const same = live('taxdocs').filter(d => d.fileName === it.name && d.path === (it.path || '') && d.sha !== it.sha);
    const issues = [...p.issues];
    if (same.length) issues.unshift('같은 이름의 파일이 내용이 바뀌어 다시 들어옴 (수정본) — 기존 건은 그대로 두었습니다');
    const id = 'tx_' + it.sha.slice(0, 24);
    put('taxdocs', {
      id, sha: it.sha, fileName: it.name, path: it.path || '', size: it.size || 0, modified: it.modified || '',
      kind: p.kind, attrYm: p.attrYm, payYm: p.payYm, amount: p.amount, due: p.due, eNo: p.eNo,
      issues, status: issues.length ? 'review' : 'ok', revisionOf: same.length ? same[0].id : '',
      pay: 'unknown', importedAt: nowTs,
    });
    bySha.set(it.sha, S.taxdocs[id]);
    if (same.length) res.revisions++; else res.added++;
    res.ids.push(id);
  }
  return res;
}

// 납부 상태: 사용자 확인 / 은행 대조 / 확인 전 (가져온 것만으로는 정하지 않음)
const TAXY = /세|국세|지방|위택스|WETAX|홈택스|국고|지로|원천|세무/i;
export function taxPayState(M, d, used = new Set()) {
  if (d.pay === 'user') return { k: 'user', label: '납부함 (사용자 확인 · 은행 대조 전)' };
  if (d.amount && d.due) {
    const t = M.txns.find(x => x.out === d.amount && !used.has(x.id) && TAXY.test(x.desc + ' ' + (x.method || '')) && dayDiff(addDays(d.due, -40), x.date) >= 0 && dayDiff(x.date, addDays(d.due, 15)) >= 0);
    if (t) { used.add(t.id); return { k: 'bank', label: `납부 확인 (통장 ${t.date.slice(5).replace('-', '/')})`, tx: t }; }
  }
  return { k: 'unknown', label: '납부 확인 전' };
}
export function taxStates(M) {
  const used = new Set(), out = new Map();
  for (const d of live('taxdocs').sort((a, b) => ((a.due || '') < (b.due || '') ? -1 : 1))) out.set(d.id, taxPayState(M, d, used));
  return out;
}
