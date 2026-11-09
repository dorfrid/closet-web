// Storage adapter: IndexedDB on the web. iOS (SwiftData) and Android implement the same functions.
const DB = "closet", VER = 1;
export const STORES = ["items", "photos", "wears", "ratings", "events", "kv"];
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
export const put = (store, obj) => tx(store, "readwrite", s => s.put(obj));
export const get = (store, id) => tx(store, "readonly", s => s.get(id));
export const all = (store) => tx(store, "readonly", s => s.getAll());
export const del = (store, id) => tx(store, "readwrite", s => s.delete(id));
export const clear = (store) => tx(store, "readwrite", s => s.clear());
export async function kvGet(k, dflt) { const r = await get("kv", k); return r ? r.value : dflt; }
export const kvSet = (k, value) => put("kv", { id: k, value });

// Ask the browser not to evict data (installed Home Screen apps are already protected).
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
