// 공통 도구: 금액은 항상 원 단위 정수로만 다룹니다.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function won(n) {
  n = Number(n) || 0;
  const s = Math.abs(n).toLocaleString('ko-KR');
  return n < 0 ? '-' + s : s;
}

export function wonSigned(n) {
  return (n > 0 ? '+' : '') + won(n);
}

// 엑셀 셀 값 → 정수(원). 소수, 문자 섞임은 오류로 처리해서 조용히 틀리지 않게 합니다.
export function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('금액이 숫자가 아닙니다');
    const r = Math.round(v);
    if (Math.abs(r - v) > 1e-9) throw new Error('원 단위가 아닌 금액: ' + v);
    if (!Number.isSafeInteger(r)) throw new Error('금액이 너무 큽니다: ' + v);
    return r;
  }
  const s = String(v).replace(/[,\s원₩]/g, '');
  if (s === '' || s === '-') return 0;
  if (!/^-?\d+$/.test(s)) throw new Error('금액 형식 오류: ' + v);
  const n = parseInt(s, 10);
  if (!Number.isSafeInteger(n)) throw new Error('금액이 너무 큽니다: ' + v);
  return n;
}

// 사용자가 입력한 금액 → 0 이상의 정수, 아니면 NaN
export function parseWonInput(str) {
  const s = String(str ?? '').replace(/[,\s원]/g, '');
  if (!/^\d+$/.test(s)) return NaN;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : NaN;
}

export function pad(n) { return String(n).padStart(2, '0'); }

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowTs() {
  const d = new Date();
  return `${todayStr()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// b - a (일)
export function dayDiff(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function ymOf(ds) { return ds.slice(0, 7); }

export function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function fmtMD(ds) {
  if (!ds) return '';
  const [, m, d] = ds.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function fmtYM(ym) {
  const [y, m] = ym.split('-');
  return `${y.slice(2)}년 ${Number(m)}월`;
}

// 은행·홈택스 날짜 문자열/엑셀 일련번호 → { date: 'YYYY-MM-DD', time: 'HH:MM:SS' | '' }
export function parseDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v > 19000101 && v < 21001231) return parseDateTime(String(v));
    if (v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        time: Number.isInteger(v) ? '' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
      };
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\.?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2}):?(\d{2}):?(\d{2})?)?$/);
  if (!m) m = s.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return {
    date: `${y}-${pad(mo)}-${pad(d)}`,
    time: m[4] !== undefined ? `${pad(+m[4])}:${m[5]}:${m[6] ? m[6] : '00'}` : '',
  };
}

// 짧고 안정적인 해시 (같은 거래 = 같은 ID → 중복 방지)
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 거래처 이름 비교용 정리: 전각문자→반각, 수협 받는분 앞 번호(088 등), (주), 주식회사, 띄어쓰기, 기호 제거
const CORP_RE = /\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)|합자회사|\(영업소\)|\(사\)|\(재\)/g;
function base(s) {
  return String(s || '').normalize('NFKC').trim().replace(/^\d{2,4}(?=\D)/, '').replace(CORP_RE, '');
}
export function normName(s) {
  return base(s).toLowerCase().replace(/[\s\-_.,·()[\]{}'"/&]+/g, '');
}

// "박정연(에스앤제이글" → 전체 / 괄호 앞 / 괄호 안 을 각각 비교
function variants(s) {
  const b = base(s);
  const out = [b];
  const p = b.indexOf('(');
  if (p >= 0) { out.push(b.slice(0, p)); out.push(b.slice(p + 1).replace(/[()]/g, '')); }
  return out.map(x => normName(x)).filter(x => x.length >= 2);
}

function coreMatch(x, y) {
  if (x === y) return true;
  if ((y.length >= 3 && x.includes(y)) || (x.length >= 3 && y.includes(x))) return true;
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  return k >= 4 || (k >= 3 && Math.min(x.length, y.length) <= 5);
}

export function nameMatch(a, b) {
  const va = variants(a), vb = variants(b);
  return va.some(x => vb.some(y => coreMatch(x, y)));
}
