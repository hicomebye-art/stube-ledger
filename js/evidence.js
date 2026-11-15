// 증빙 사진: 줄이기 → 이 기기에 잠시 보관 → 구글 드라이브(비공개)에 올리기
// - 인터넷이 끊겼거나 로그인 전이면 이 기기(IndexedDB)에 보관했다가, 연결되면 자동으로 올립니다.
// - 같은 사진(내용이 똑같은 파일)을 또 올리면 한 번만 저장합니다.
// - 사진은 대표님 드라이브에만 있고, 로그인한 사람만 볼 수 있습니다. 앱 코드나 기록에는 사진 내용이 들어가지 않습니다.
import { put, patch, commit, live } from './store.js';
import * as drive from './drive.js';
import { uid, nowTs } from './util.js';
import { NS } from './env.js';

const DB = 'stube-evid' + NS;
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('q', mode);
    const out = fn(t.objectStore('q'));
    t.oncomplete = () => { db.close(); res(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}
const qPut = rec => tx('readwrite', s => s.put(rec));
const qGet = id => tx('readonly', s => s.get(id));
const qAll = () => tx('readonly', s => s.getAll());
const qDel = id => tx('readwrite', s => s.delete(id));

// 사진 줄이기 (긴 변 1600px, JPEG). 사진이 아니면 그대로 (10MB까지)
export async function shrink(file) {
  if (!/^image\//.test(file.type) || /gif|svg/.test(file.type)) {
    if (file.size > 10 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (10MB 이하)');
    return file;
  }
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('사진을 읽지 못했습니다')); im.src = URL.createObjectURL(file); }); }
  const w = bmp.width, h = bmp.height, k = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  return blob && blob.size < file.size ? blob : file;
}

export async function sha(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 비용(costId)에 증빙 붙이기. 결과: { id } 또는 { dup: 기존 증빙 }
export async function addEvidence(file, costId, kind = 'receipt') {
  const blob = await shrink(file);
  const h = await sha(blob);
  const dup = live('evid').find(e => e.sha === h);
  if (dup) return { dup };
  const id = uid('ev');
  const ext = blob.type === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop() || 'bin').toLowerCase();
  await qPut({ id, blob, name: `${id}.${ext}` });
  put('evid', { id, costId, kind, fileId: '', name: `${id}.${ext}`, mime: blob.type, size: blob.size, sha: h, at: nowTs(), pending: true });
  commit('evid');
  flushQueue();
  return { id };
}

// 보관 중인 사진을 드라이브로 올리기 (로그인돼 있을 때)
let flushing = null;
export function flushQueue() {
  if (flushing || !drive.hasToken() || !navigator.onLine) return flushing || Promise.resolve();
  flushing = (async () => {
    for (const r of await qAll()) {
      try {
        const fileId = await drive.uploadBlob(r.blob, r.name);
        patch('evid', r.id, { fileId, pending: false });
        await qDel(r.id);
        commit('evid');
      } catch { break; }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
export async function pendingCount() { try { return (await qAll()).length; } catch { return 0; } }

// 화면에 보여줄 주소: 이 기기에 아직 있으면 그것, 아니면 드라이브에서 받아옴
export async function evidenceUrl(ev) {
  const local = await qGet(ev.id).catch(() => null);
  if (local) return URL.createObjectURL(local.blob);
  if (!ev.fileId) throw new Error('아직 다른 기기에서 올라오지 않은 사진입니다');
  return URL.createObjectURL(await drive.downloadBlob(ev.fileId));
}
