// 읽은 엑셀 결과를 장부에 넣기 (같은 거래는 한 번만 들어감)
import { store, put, patch, commit } from './store.js';
import { hash, uid, nowTs } from './util.js';

export const BANK_TO_ACCT = { suhyup: 'suhyup', nh: 'nh', kakao: 'kakao', post: 'post' };

export function txnId(acct, r) {
  return 't' + hash([acct, r.date, r.time, r.in, r.out, r.bal, r.desc].join('|'));
}

// 미리보기용: 새로 들어갈 건수 / 이미 있는 건수
export function previewCounts(res, acct) {
  const S = store.state;
  let fresh = 0, dup = 0;
  if (res.type === 'bank') {
    for (const r of res.rows) (S.txns[txnId(acct, r)] ? dup++ : fresh++);
  } else {
    for (const v of res.list) (S.invoices[v.id] ? dup++ : fresh++);
  }
  return { fresh, dup };
}

export function commitImport(res, fileName, acct) {
  const S = store.state;
  const impId = uid('imp');
  let added = 0, dup = 0, updated = 0;
  if (res.type === 'bank') {
    res.rows.forEach((r, k) => {
      const id = txnId(acct, r);
      if (S.txns[id]) { dup++; return; }
      put('txns', {
        id, acct, date: r.date, time: r.time, ts: r.date + ' ' + (r.time || '00:00:00'), ord: k, imp: impId,
        in: r.in, out: r.out, bal: r.bal, desc: r.desc, method: r.method, branch: r.branch, memo: r.memo,
        personal: false, note: '',
      });
      added++;
    });
    // 예금주(대표) 이름: 대표 본인 계좌와 주고받은 돈을 이중송금·계산서 검토에서 빼는 데 씁니다
    const a = S.accounts[acct];
    if (a && res.holder && !a.owner) patch('accounts', acct, { owner: res.holder });
  } else {
    const core = ['kind', 'wdate', 'idate', 'biz', 'name', 'rep', 'dom', 'total', 'supply', 'tax', 'cls', 'typ', 'note', 'rc', 'item', 'orig'];
    const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
    for (const v of res.list) {
      const ex = S.invoices[v.id];
      if (!ex) { put('invoices', { ...v, settled: false, linkTxns: [] }); added++; }
      else if (ex.deleted) dup++;
      else if (core.some(k => !same(ex[k], v[k]))) { patch('invoices', v.id, Object.fromEntries(core.map(k => [k, v[k]]))); updated++; }
      else dup++;
    }
  }
  put('imports', {
    id: impId, at: nowTs(), file: fileName, type: res.type, kind: res.kind || '', acct: acct || '',
    from: res.from, to: res.to, rows: (res.rows || res.list).length, added, dup, updated,
    ok: (res.checks || []).every(c => c.ok),
  });
  commit('import');
  return { added, dup, updated };
}
