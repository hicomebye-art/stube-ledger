// 영수증·이체 캡처 사진 → 글자 → 날짜·상대방·금액·공급가·부가세·입출금 방향
// 원칙: 사진에서 분명히 읽힌 값만 채웁니다. 못 읽은 값은 비워두고, 계산해서 만들어 넣지 않습니다.
import * as drive from './drive.js';
import { shrink } from './evidence.js';

// 글자 인식 엔진 (테스트에서는 가짜로 바꿔 끼울 수 있게)
export const engine = { run: blob => drive.ocrImage(blob) };

export async function readPhoto(file) {
  if (!drive.hasToken()) throw new Error('구글 드라이브 연결이 필요합니다 (사진 글자 읽기는 드라이브 기능을 씁니다)');
  if (!navigator.onLine) throw new Error('인터넷이 연결돼야 사진 글자를 읽을 수 있습니다');
  const blob = await shrink(file);
  const text = await engine.run(blob);
  return { text, ...parseReceipt(text) };
}

const N = s => String(s).normalize('NFKC');
// 손글씨는 쉼표 자리가 틀리기도 함 (4,8300 → 48300). 쉼표로만 이어진 숫자는 숫자만 모아 읽고, 화면에 확인 경고
const AMT_RE = /(?:₩|\\)?\s*(\d{1,3}(?:\.\d{3})+(?![\d,])|\d+(?:,\d+)+|\d{3,9})(?!\d)\s*원?/g;
const oddComma = raw => /,/.test(raw) && !/^\d{1,3}(?:,\d{3})+$/.test(raw);
const toWon = s => { const v = s.replace(/[^\d]/g, ''); return v ? parseInt(v, 10) : NaN; };

function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMT_RE)) {
    const raw = m[1];
    // 전화번호·카드번호·사업자번호 조각, 연도 같은 숫자는 빼기
    if (/^(19|20)\d{2}$/.test(raw)) continue;
    const v = toWon(raw);
    if (Number.isSafeInteger(v) && v >= 100 && v <= 999999999) out.push(v);
  }
  return out;
}

// 키워드가 있는 줄에서 금액 찾기 (같은 줄에 없으면 바로 다음 줄)
function keyAmounts(lines, keyRe, skipRe) {
  const res = [];
  lines.forEach((l, i) => {
    if (!keyRe.test(l) || (skipRe && skipRe.test(l))) return;
    const after = l.slice(l.search(keyRe));
    let a = amountsIn(after);
    // 표 머리줄(품목·수량·단가…)이면 다음 줄은 품목 줄이라 읽지 않음
    if (!a.length && lines[i + 1] && !keyRe.test(lines[i + 1]) && !/수\s*량|단\s*가|규\s*격|품\s*목/.test(l)) a = amountsIn(lines[i + 1]);
    if (a.length) res.push(a[0]); // 키워드 바로 뒤의 첫 금액
  });
  return res;
}

const TOTAL_RE = /(합\s*계|총\s*액|총\s*합\s*계|총\s*금\s*액|결\s*제\s*금\s*액|받\s*을\s*금\s*액|청\s*구\s*금\s*액|판\s*매\s*금\s*액|승\s*인\s*금\s*액|이\s*체\s*금\s*액|보\s*낸\s*금\s*액|출\s*금\s*금\s*액|입\s*금\s*금\s*액|합계\s*금액|TOTAL|AMOUNT)/i;
const VAT_RE = /(부\s*가\s*세|부가가치세|세\s*액|V\s*\.?\s*A\s*\.?\s*T)/i;
const SUPPLY_RE = /(공\s*급\s*가\s*액?|과\s*세\s*물\s*품\s*가?\s*액?|과\s*세\s*금\s*액|과\s*세\s*매\s*출)/;
const VENDOR_RE = /(상\s*호\s*명?|가\s*맹\s*점\s*명?|매\s*장\s*명|판\s*매\s*자|업\s*체\s*명|받는\s*분|받는\s*사람|받으시는\s*분|입금\s*받는\s*분|예금주|보낸\s*분)\s*[:：]?\s*(.*)$/;
const NOT_VENDOR = /영수증|매출전표|신용카드|카드\s*승인|체크카드|거래\s*명\s*세|간이|고객용|가맹점용|사업자|대표|주소|전화|TEL|일시|날짜|번호|승인|금액|합계|부가세|공급|이체|송금|입금|출금|완료|결과|조회|귀\s*하|계산합니다|등\s*록|성\s*명|업\s*태|종\s*목|소재지|품\s*목|규\s*격|수\s*량|단\s*가/i;
// 거래명세표 양식 글자 (상호 칸이 비어 있으면 옆 칸 이름표가 읽힘) — 지급처로 쓰지 않음
const FORM_LABEL = /^(성\s*명|사\s*업\s*장|소\s*재\s*지|업\s*태|종\s*목|등\s*록|번\s*호|귀\s*하|\(?인\)?|㊞)/;

function findDate(text) {
  const t = N(text);
  const pats = [
    /(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/,
    /(?<!\d)(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (!m) continue;
    let y = Number(m[1]); if (y < 100) y += 2000;
    const mo = Number(m[2]), d = Number(m[3]);
    if (y >= 2000 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return '';
}

function findVendor(lines) {
  for (const l of lines) {
    const m = l.match(VENDOR_RE);
    if (m) {
      let v = (m[2] || '').replace(/\d{3}-\d{2}-\d{5}.*/, '').replace(/(대표자?|TEL|전화).*/i, '').replace(/[:：]/g, '').trim();
      if (v.length >= 2 && !/^\d/.test(v) && !FORM_LABEL.test(v) && !/귀\s*하/.test(v)) return v.slice(0, 40);
    }
  }
  // 이름표가 없으면: 위쪽 몇 줄 중 글자가 대부분인 줄 (보통 가게 이름)
  for (const [i, l] of lines.slice(0, 6).entries()) {
    if (/년\s*월\s*일|^권\s*호?$/.test(l) || VENDOR_RE.test(l) || /^귀\s*하/.test(lines[i + 1] || '')) continue; // 빈 날짜칸, "OOO 귀하"(받는 쪽 = 우리)
    const hangul = (l.match(/[가-힣A-Za-z]/g) || []).length;
    if (hangul >= 2 && hangul >= l.replace(/\s/g, '').length * 0.6 && !NOT_VENDOR.test(l)) return l.slice(0, 40);
  }
  return '';
}

export function parseReceipt(text) {
  const lines = N(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const warn = [];
  const totals = keyAmounts(lines, TOTAL_RE, /면세/);
  const vats = keyAmounts(lines, VAT_RE, /포함|별도/);
  const supplies = keyAmounts(lines, SUPPLY_RE, null);
  const total = totals.length ? Math.max(...totals) : null;
  const vat = vats.length ? vats[0] : null;
  const supply = supplies.length ? supplies[0] : null;
  const biz = (N(text).match(/\d{3}-\d{2}-\d{5}/) || [''])[0];
  const date = findDate(text);
  const vendor = findVendor(lines);
  const t = N(text);
  // 입금 알림(받은 돈)인지: "입금되었습니다/입금 완료/입금 금액" 이 있고, 출금·이체 완료·보낸 금액이 없을 때만
  const dir = /입금\s*(완료|되었|내역|확인|금액)|받은\s*금액|입금되었습니다/.test(t) && !/출금|이체\s*완료|송금\s*완료|보낸\s*금액/.test(t) ? 'in' : 'out';
  const kind = /이체|송금|받는\s*분|보낸\s*분|입금\s*받는/.test(t) ? 'transfer' : 'receipt';
  if (total == null) warn.push('합계 금액을 못 읽었습니다');
  if (!date) warn.push('날짜를 못 읽었습니다');
  if (supply != null && vat != null && total != null && supply + vat !== total) warn.push(`공급가+부가세(${(supply + vat).toLocaleString('ko-KR')})가 합계와 다릅니다 — 사진을 확인하세요`);
  if (vat != null && supply == null) warn.push('부가세는 읽었지만 공급가를 못 읽었습니다');
  if ([...t.matchAll(/\d+(?:,\d+)+/g)].some(m => oddComma(m[0]))) warn.push('쉼표 자리가 맞지 않는 숫자가 있습니다 (손글씨일 수 있음) — 금액을 꼭 확인하세요');
  return { date, vendor, biz, total, supply, vat, dir, kind, warn };
}
