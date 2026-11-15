// 세무자료 가져오기 화면 (PC): 폴더 선택(읽기 전용) → PDF 글자 읽기(이 PC 안에서만) → 세무 목록
import { store, live, patch, put, commit, remove } from './store.js';
import { esc, won, fmtMD, uid, nowTs } from './util.js';
import { NS } from './env.js';
import { TAX_KIND, ymLabel, monthsLabel, importTaxDocs, taxStates } from './tax.js';
import { render, toast } from './views.js';

export const tui = { busy: false, msg: '', dirName: '', dirLoaded: false };
const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;

// ───── PDF 글자 읽기 (pdf.js, 이 PC 브라우저 안에서만 처리. PDF를 밖으로 보내지 않음) ─────
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
let pdfjsP = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  pdfjsP = pdfjsP || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'build/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsP = null; rej(new Error('PDF 읽기 모듈을 불러오지 못했습니다 (인터넷 연결 확인)')); };
    document.head.appendChild(s);
  });
  return pdfjsP;
}
export async function pdfText(buf) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/', isEvalSupported: false }).promise;
  const out = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = it.transform[5];
        let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x: it.transform[4], w: it.width || 0, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let line = '', end = null;
        for (const i of r.items) { line += (end != null && i.x - end > 1.5 ? ' ' : '') + i.s; end = i.x + i.w; }
        out.push(line.replace(/\s+/g, ' ').trim());
      }
    }
  } finally { doc.destroy(); }
  return out.join('\n');
}

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ───── 연결한 폴더 기억 (이 PC에만, 읽기 권한) ─────
const DB = 'stube-tax' + NS;
function idb(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result, t = db.transaction('kv', mode), q = fn(t.objectStore('kv'));
      t.oncomplete = () => { db.close(); res(q && q.result); };
      t.onerror = () => { db.close(); rej(t.error); };
    };
  });
}
const getDir = () => idb('readonly', s => s.get('dir')).catch(() => null);
const setDir = h => idb('readwrite', s => s.put(h, 'dir'));
export async function loadDirName() { const h = await getDir(); tui.dirName = h ? h.name : ''; tui.dirLoaded = true; }

async function* walk(dir, path = '', depth = 0) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file' && /\.pdf$/i.test(name)) yield { h, name, path };
    else if (h.kind === 'directory' && depth < 3) yield* walk(h, path + name + '/', depth + 1);
  }
}

// files: [{ file, name, path }]
export async function readAndImport(files) {
  const known = new Set(live('taxdocs').map(d => d.sha));
  const items = [];
  let unreadable = 0;
  for (const f of files) {
    const buf = await f.file.arrayBuffer();
    const sha = await sha256(buf);
    if (known.has(sha)) { items.push({ name: f.name, path: f.path, sha, text: '' }); continue; } // 같은 PDF: 읽지 않고 건너뜀
    let text = '';
    try { text = await pdfText(buf); } catch (e) { unreadable++; text = ''; }
    items.push({ name: f.name, path: f.path || '', size: f.file.size, modified: new Date(f.file.lastModified || Date.now()).toISOString().slice(0, 16), sha, text });
  }
  const r = importTaxDocs(items, nowTs());
  if (r.added || r.revisions) commit('tax');
  r.unreadable = unreadable;
  return r;
}

function resultMsg(r, total) {
  return `PDF ${total}개 확인 → 새로 ${r.added}건${r.revisions ? ` · 수정본 ${r.revisions}건 (확인 필요)` : ''} · 이미 있음 ${r.dup}건${r.skipped ? ` · 납부서 아님 ${r.skipped}건 (건너뜀)` : ''}`;
}

async function scanDir(h) {
  const files = [];
  for await (const e of walk(h)) files.push({ file: await e.h.getFile(), name: e.name, path: e.path });
  const r = await readAndImport(files);
  tui.msg = resultMsg(r, files.length);
  return r;
}

// ───── 화면 ─────
export function taxSection(M) {
  if (!tui.dirLoaded) loadDirName().then(render);
  const st = taxStates(M);
  const docs = live('taxdocs').filter(d => d.status !== 'ignored').sort((a, b) => ((b.payYm || '') + b.kind < (a.payYm || '') + a.kind ? -1 : 1));
  const picker = 'showDirectoryPicker' in window;
  const row = d => {
    const ps = st.get(d.id);
    const planned = live('plans').some(p => p.taxDocId === d.id);
    const readTag = d.status === 'review' ? tag('확인 필요', 'red') : d.status === 'replaced' ? tag('수정본으로 바뀜', 'gray') : tag('확정', 'green');
    const acts = [
      d.status === 'review' ? `<button class="sm" data-act="taxEdit" data-id="${d.id}">고치기</button><button class="sm primary" data-act="taxOk" data-id="${d.id}">${d.revisionOf ? '이 수정본으로 확정' : '확정'}</button>${d.revisionOf ? `<button class="sm ghost" data-act="taxIgnore" data-id="${d.id}">무시</button>` : ''}` : '',
      d.status === 'ok' ? (ps.k === 'unknown' ? `<button class="sm" data-act="taxPaid" data-id="${d.id}">납부함</button>` : d.pay === 'user' ? `<button class="sm ghost" data-act="taxUnpaid" data-id="${d.id}">납부 표시 취소</button>` : '') : '',
      d.status === 'ok' && ps.k === 'unknown' && d.due && d.amount && !planned ? `<button class="sm ghost" data-act="taxPlan" data-id="${d.id}">자금 계획에 넣기</button>` : '',
    ].join('');
    return `<tr class="${d.status === 'replaced' ? 'dim' : ''}"><td class="wrap">${esc(d.fileName)}${d.path ? `<div class="muted s">${esc(d.path)}</div>` : ''}</td>
      <td>${d.kind ? TAX_KIND[d.kind] : '<span class="muted">?</span>'}</td><td class="nowrap">${esc(monthsLabel(d)) || '<span class="muted">?</span>'}</td>
      <td class="r">${d.amount != null ? won(d.amount) : '<span class="muted">빈칸</span>'}</td><td class="nowrap">${d.due ? esc(d.due) : '<span class="muted">빈칸</span>'}</td>
      <td>${readTag}${d.issues && d.issues.length && d.status === 'review' ? `<div class="hint">${d.issues.map(esc).join('<br>')}</div>` : ''}</td>
      <td>${d.status === 'ok' ? tag(ps.label, { bank: 'green', user: 'blue', unknown: 'gray' }[ps.k]) : ''}${planned ? ' ' + tag('계획에 있음') : ''}</td><td class="act">${acts}</td></tr>`;
  };
  return `<section class="card" id="taxsec"><div class="row-h"><h2>세무자료 가져오기 <span class="muted">근로소득세·지방소득세 납부서 PDF</span></h2></div>
    <div class="hint">윈도우 탐색기의 <b>Google Drive → 내 드라이브 → 에스튜브 세무자료</b> 폴더를 고르세요. 읽기만 하며 원본을 옮기거나 이름을 바꾸지 않습니다. PDF는 이 PC 안에서만 읽고 어디에도 올리지 않습니다 (장부에는 읽은 값만 저장).</div>
    <div class="btns">
      ${picker ? `<button class="primary" data-act="taxPick" ${tui.busy ? 'disabled' : ''}>세무자료 폴더 선택</button>` : ''}
      ${picker && tui.dirName ? `<button data-act="taxScan" ${tui.busy ? 'disabled' : ''}>새 자료 확인</button> <span class="muted">연결된 폴더: ${esc(tui.dirName)}</span>` : ''}
      <label class="btn">${picker ? 'PDF 직접 고르기' : 'PDF 여러 개 고르기'}<input type="file" accept="application/pdf,.pdf" multiple data-chg="taxFiles" hidden></label>
    </div>
    ${tui.busy ? '<div class="note">PDF 읽는 중…</div>' : ''}${tui.msg ? `<div class="okline">${esc(tui.msg)}</div>` : ''}
    ${docs.length ? `<table class="tbl"><thead><tr><th>원본 파일명</th><th>세목</th><th>귀속 / 지급</th><th class="r">납부금액</th><th>납부기한</th><th>읽기</th><th>납부 상태</th><th></th></tr></thead><tbody>${docs.map(row).join('')}</tbody></table>
      <div class="hint">"확정"한 건만 핸드폰에 보입니다. 납부 상태는 통장에서 같은 금액의 세금 출금이 확인되거나, "납부함"을 누를 때만 바뀝니다.</div>` : '<div class="muted">아직 가져온 세무자료가 없습니다.</div>'}
  </section>`;
}

// 핸드폰: 확정된 세무 목록과 납부 상태만
export function taxMobile(M) {
  const st = taxStates(M);
  const docs = live('taxdocs').filter(d => d.status === 'ok').sort((a, b) => ((a.due || '9') < (b.due || '9') ? 1 : -1)).slice(0, 8);
  if (!docs.length) return '';
  return `<section class="mcard"><h2>세금 납부 (원천세)</h2>${docs.map(d => { const ps = st.get(d.id); return `<div class="mrow"><span class="d">${d.due ? fmtMD(d.due) : '-'}</span><span class="t">${TAX_KIND[d.kind] || ''} ${esc(monthsLabel(d))}<br>${tag(ps.label, { bank: 'green', user: 'blue', unknown: 'gray' }[ps.k])}</span><span class="num out">-${d.amount != null ? won(d.amount) : '?'}</span></div>`; }).join('')}</section>`;
}

// ───── 동작 ─────
export function extendTaxUI({ ACT, CHG }) {
  const run = async fn => {
    tui.busy = true; render();
    try { await fn(); } catch (e) { tui.msg = ''; toast(e.name === 'AbortError' ? '폴더 선택을 취소했습니다' : '세무자료를 읽지 못했습니다: ' + e.message); }
    finally { tui.busy = false; render(); }
  };
  Object.assign(ACT, {
    taxPick: () => run(async () => {
      const h = await window.showDirectoryPicker({ id: 'stube-tax', mode: 'read' });
      await setDir(h); tui.dirName = h.name;
      await scanDir(h);
    }),
    taxScan: () => run(async () => {
      const h = await getDir();
      if (!h) { toast('폴더를 다시 선택해 주세요'); return; }
      let p = await h.queryPermission({ mode: 'read' });
      if (p === 'prompt') p = await h.requestPermission({ mode: 'read' });
      if (p !== 'granted') { tui.dirName = ''; toast('폴더 읽기 권한이 끊겼습니다. [세무자료 폴더 선택]으로 다시 골라주세요'); return; }
      await scanDir(h);
    }),
    taxEdit: el => {
      const d = store.state.taxdocs[el.dataset.id];
      const k = prompt('세목: 1 = 근로소득세, 2 = 지방소득세', d.kind === 'local' ? '2' : d.kind === 'wage' ? '1' : '');
      if (k === null) return;
      const at = prompt('귀속월 (예: 2026-09)', d.attrYm || ''); if (at === null) return;
      const pa = prompt('지급월 (예: 2026-10)', d.payYm || ''); if (pa === null) return;
      const am = prompt('납부금액 (납부서에 적힌 그대로)', d.amount != null ? won(d.amount) : ''); if (am === null) return;
      const du = prompt('납부기한 (예: 2026-11-10)', d.due || ''); if (du === null) return;
      const amount = am.trim() === '' ? null : parseInt(am.replace(/[,\s원]/g, ''), 10);
      const okYm = s => s === '' || /^20\d{2}-(0[1-9]|1[0-2])$/.test(s.trim());
      if (!okYm(at) || !okYm(pa) || (du.trim() && !/^20\d{2}-\d{2}-\d{2}$/.test(du.trim())) || (amount != null && !(amount > 0))) { toast('형식이 맞지 않습니다 (월 2026-09, 날짜 2026-11-10, 금액 숫자)'); return; }
      patch('taxdocs', d.id, { kind: k.trim() === '2' ? 'local' : k.trim() === '1' ? 'wage' : d.kind, attrYm: at.trim(), payYm: pa.trim(), amount, due: du.trim(), editedAt: nowTs() });
      commit('tax');
    },
    taxOk: el => {
      const d = store.state.taxdocs[el.dataset.id];
      const miss = [!d.kind && '세목', !d.attrYm && '귀속월', !d.payYm && '지급월', d.amount == null && '납부금액', !d.due && '납부기한'].filter(Boolean);
      if (miss.length) { toast(`${miss.join(', ')}이(가) 비어 있습니다. [고치기]로 납부서를 보고 넣어주세요`); return; }
      if (d.revisionOf && store.state.taxdocs[d.revisionOf]) {
        if (!confirm('이 수정본으로 확정할까요? 이전 건은 "수정본으로 바뀜"으로 남겨둡니다 (지우지 않음).')) return;
        patch('taxdocs', d.revisionOf, { status: 'replaced' });
        for (const p of live('plans').filter(p => p.taxDocId === d.revisionOf && !p.done)) remove('plans', p.id);
      }
      patch('taxdocs', d.id, { status: 'ok', confirmedAt: nowTs() });
      commit('tax');
    },
    taxIgnore: el => { patch('taxdocs', el.dataset.id, { status: 'ignored' }); commit('tax'); },
    taxPaid: el => { patch('taxdocs', el.dataset.id, { pay: 'user', paidAt: nowTs() }); commit('tax'); toast('납부함으로 표시했습니다 (사용자 확인 · 은행 대조 전)'); },
    taxUnpaid: el => { patch('taxdocs', el.dataset.id, { pay: 'unknown', paidAt: '' }); commit('tax'); },
    taxPlan: el => {
      const d = store.state.taxdocs[el.dataset.id];
      put('plans', { id: uid('p'), date: d.due, kind: 'out', pay: 'direct', amount: d.amount, title: `${TAX_KIND[d.kind]} ${ymLabel(d.attrYm)} 귀속`, acct: '', cat: 'tax', taxDocId: d.id, personal: false, done: false });
      commit('plan'); toast('자금 계획에 넣었습니다 (납부가 확인되면 저절로 완료)');
    },
  });
  Object.assign(CHG, {
    taxFiles: el => {
      const files = [...el.files].map(f => ({ file: f, name: f.name, path: '' }));
      el.value = '';
      run(async () => { const r = await readAndImport(files); tui.msg = resultMsg(r, files.length); });
    },
  });
}
