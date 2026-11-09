// Sync through the user's own Google Drive, in the hidden app-data folder (scope drive.appdata:
// the app can only see files it created; nothing else in Drive is visible to it, and the user
// cannot browse these files). No server of ours. The Anthropic key and per-device caches never leave the device.
//
// Remote layout (appDataFolder):
//   db.json          items, wears, ratings, events, photo metadata, settings
//   o_<photoId>      original photo (face-free crop or the user's own garment photo)
//   c_<photoId>      background-removed cutout
// Each photo file carries appProperties.v = the photo version (updatedAt), so only changed photos move.
//
// Merge rules (same as the spec): per record, newest updatedAt wins (soft deletes are updates);
// ratings and events are append-only (union by id); settings: newest settings.updatedAt wins.

import * as db from "./db.js";

// OAuth Client ID is public by design (it identifies the app, it is not a secret). Paste it here or in Settings.
export const GOOGLE_CLIENT_ID = "";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3";
const KV = "gdrive", REDIRECT_GUARD = "gdrive:redirectAt";
const RECORD_STORES = ["items", "wears", "ratings", "events"];
const APPEND_ONLY = new Set(["ratings", "events"]);

const same = p => !!p.cutout && !!p.original && (p.cutout === p.original || (p.cutout.size === p.original.size && p.cutout.type === p.original.type));
const ver = r => r?.updatedAt || r?.deletedAt || r?.createdAt || r?.ts || "";
const redirectURI = () => location.origin + location.pathname;

export async function syncState() { return (await db.kvGet(KV, null)) || { connected: false }; }
async function setState(patch) { const s = { ...(await syncState()), ...patch }; await db.kvSet(KV, s); return s; }
export async function clientId() { return GOOGLE_CLIENT_ID || (await syncState()).clientId || ""; }
export async function saveClientId(id) { await setState({ clientId: id.trim() }); }
function tokenValid(s) { return s.token && s.exp && Date.now() < s.exp - 60e3; }

// ---------- sign-in (redirect flow: works inside a Home Screen app, where popups are unreliable) ----------
export async function signIn({ silent = false } = {}) {
  const cid = await clientId();
  if (!cid) throw new Error("No Google Client ID set");
  const st = crypto.randomUUID();
  localStorage.setItem("gdrive:state", JSON.stringify({ st, search: location.search, silent }));
  localStorage.setItem(REDIRECT_GUARD, String(Date.now()));
  const q = new URLSearchParams({ client_id: cid, redirect_uri: redirectURI(), response_type: "token", scope: SCOPE,
    include_granted_scopes: "true", state: st, prompt: silent ? "none" : "consent" });
  const s = await syncState();
  if (s.email) q.set("login_hint", s.email);
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
}

// Call once at boot, before anything else reads the URL. Returns "connected" | "needs-consent" | null.
export async function handleRedirect() {
  if (!location.hash.includes("state=")) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("gdrive:state") || "null"); } catch {}
  localStorage.removeItem("gdrive:state");
  history.replaceState(null, "", location.pathname + (saved?.search || ""));
  if (!saved || h.get("state") !== saved.st) return null; // not ours, or forged
  if (h.get("error")) { await setState({ token: null, exp: 0, needsConsent: h.get("error") !== "access_denied" ? true : false }); return "needs-consent"; }
  const token = h.get("access_token"), exp = Date.now() + (+h.get("expires_in") || 3600) * 1000;
  await setState({ connected: true, token, exp, needsConsent: false });
  return "connected";
}

// If connected but the 1-hour token expired, renew it silently (a quick round-trip to Google). Guarded against loops.
export async function renewIfNeeded() {
  const s = await syncState();
  if (!s.connected || tokenValid(s) || s.needsConsent) return false;
  const last = +localStorage.getItem(REDIRECT_GUARD) || 0;
  if (Date.now() - last < 10 * 60e3) return false;
  if (!navigator.onLine) return false;
  await signIn({ silent: true });
  return true;
}

export async function disconnect() {
  const s = await syncState();
  if (s.token) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(s.token), { method: "POST" }).catch(() => {});
  await db.kvSet(KV, { connected: false, clientId: s.clientId || "" });
}

// ---------- Drive helpers ----------
async function call(token, url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: "Bearer " + token, ...(opt.headers || {}) } });
  if (r.status === 401) { await setState({ token: null, exp: 0 }); throw new Error("Google sign-in expired"); }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r;
}
async function listFiles(token) {
  const out = [];
  let page = "";
  do {
    const q = new URLSearchParams({ spaces: "appDataFolder", pageSize: "1000", fields: "nextPageToken,files(id,name,appProperties)" });
    if (page) q.set("pageToken", page);
    const j = await (await call(token, `${API}/files?${q}`)).json();
    out.push(...j.files); page = j.nextPageToken || "";
  } while (page);
  return out;
}
function multipart(meta, blob) {
  const b = "closet" + crypto.randomUUID().replace(/-/g, "");
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${b}--`]);
  return { body, type: `multipart/related; boundary=${b}` };
}
async function upload(token, existing, name, blob, appProperties = {}) {
  const meta = existing ? { appProperties } : { name, parents: ["appDataFolder"], appProperties };
  const { body, type } = multipart(meta, blob);
  const url = existing ? `${UP}/files/${existing.id}?uploadType=multipart&fields=id,name,appProperties` : `${UP}/files?uploadType=multipart&fields=id,name,appProperties`;
  return (await call(token, url, { method: existing ? "PATCH" : "POST", body, headers: { "Content-Type": type } })).json();
}
const download = async (token, f) => (await call(token, `${API}/files/${f.id}?alt=media`)).blob();

async function pool(tasks, n, onTick) {
  let i = 0, done = 0;
  const worker = async () => { while (i < tasks.length) { const t = tasks[i++]; await t(); onTick?.(++done, tasks.length); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

// ---------- merge (pure; also used by tests) ----------
export function mergeStore(store, local, remote) {
  const byId = new Map(local.map(r => [r.id, r]));
  const toLocal = [];
  let remoteChanged = false;
  const remoteIds = new Set();
  for (const r of remote) {
    remoteIds.add(r.id);
    const l = byId.get(r.id);
    if (!l) { byId.set(r.id, r); toLocal.push(r); continue; }
    if (APPEND_ONLY.has(store)) continue;
    const lv = ver(l), rv = ver(r);
    if (rv > lv) { byId.set(r.id, r); toLocal.push(r); }
    else if (lv > rv) remoteChanged = true;
  }
  if (local.some(l => !remoteIds.has(l.id))) remoteChanged = true;
  return { merged: [...byId.values()], toLocal, remoteChanged };
}

// ---------- full sync ----------
let running = null;
export function sync(opts) {
  return (running ||= (async () => { db.mute(true); try { return await doSync(opts); } catch (e) { await setState({ lastError: String(e.message || e).slice(0, 160) }); throw e; } finally { db.mute(false); } })().finally(() => (running = null)));
}
export const isRunning = () => !!running;

async function doSync({ onProgress } = {}) {
  const s = await syncState();
  if (!s.connected) throw new Error("Not connected");
  if (!tokenValid(s)) throw new Error("Google sign-in expired");
  const token = s.token, say = (t) => onProgress?.(t);
  say("Checking Google Drive…");
  const files = await listFiles(token), byName = new Map(files.map(f => [f.name, f]));
  const remote = byName.get("db.json") ? JSON.parse(await (await download(token, byName.get("db.json"))).text()) : null;
  if (remote && remote.schemaVersion > 1) throw new Error("Drive copy is from a newer app version. Update the app first.");

  let changedLocal = 0, needUpload = !remote;
  const out = { format: "closet-sync", schemaVersion: 1, updatedAt: new Date().toISOString() };
  for (const st of RECORD_STORES) {
    const { merged, toLocal, remoteChanged } = mergeStore(st, await db.all(st), remote?.[st] || []);
    for (const r of toLocal) await db.put(st, r);
    if (st !== "events") changedLocal += toLocal.length;
    needUpload ||= remoteChanged;
    out[st] = merged;
  }
  // settings
  const ls = await db.kvGet("settings", null), rs = remote?.settings || null;
  if (rs && (!ls || (rs.updatedAt || "") > (ls.updatedAt || ""))) { await db.kvSet("settings", rs); changedLocal++; out.settings = rs; }
  else { out.settings = ls; if (ls && (ls.updatedAt || "") !== (rs?.updatedAt || "")) needUpload = true; }

  // photos: metadata travels in db.json, bytes as separate files
  const localPhotos = await db.all("photos"), lp = new Map(localPhotos.map(p => [p.id, p]));
  const rmeta = new Map((remote?.photos || []).map(p => [p.id, p]));
  const tasks = [];
  for (const p of localPhotos) {
    const v = ver(p), rm = rmeta.get(p.id);
    if (rm && rm.v >= v) continue;
    tasks.push(async () => {
      if (!rm || !byName.get("o_" + p.id) || (byName.get("o_" + p.id).appProperties?.v || "") < v)
        if (p.original) await upload(token, byName.get("o_" + p.id), "o_" + p.id, p.original, { v, pid: p.id, kind: "o" });
      if (p.cutout && !same(p)) await upload(token, byName.get("c_" + p.id), "c_" + p.id, p.cutout, { v, pid: p.id, kind: "c" });
    });
  }
  for (const [id, rm] of rmeta) {
    const l = lp.get(id);
    if (l && ver(l) >= rm.v) continue;
    tasks.push(async () => {
      const of = byName.get("o_" + id), cf = byName.get("c_" + id);
      if (!of) return;
      const original = await download(token, of), cutout = rm.sameCutout ? original : cf ? await download(token, cf) : null;
      await db.put("photos", { id, createdAt: rm.createdAt, updatedAt: rm.v, source: rm.source, original, cutout });
      changedLocal++;
    });
  }
  if (tasks.length) await pool(tasks, 4, (d, n) => say(`Syncing photos ${d} of ${n}…`));
  const allPhotos = await db.all("photos");
  out.photos = allPhotos.map(p => ({ id: p.id, v: ver(p), createdAt: p.createdAt, source: p.source || null, sameCutout: same(p) }));
  if (tasks.length || out.photos.length !== (remote?.photos || []).length) needUpload = true;

  if (needUpload) {
    say("Saving to Google Drive…");
    await upload(token, byName.get("db.json"), "db.json", new Blob([JSON.stringify(out)], { type: "application/json" }), { v: out.updatedAt });
  }
  const res = { at: new Date().toISOString(), changedLocal, uploaded: needUpload, items: out.items.filter(i => !i.deletedAt).length, photos: out.photos.length };
  await setState({ lastSync: res.at, lastResult: res, lastError: null });
  return res;
}

// Remove everything this app stored in the user's Drive (the hidden folder only).
export async function wipeRemote() {
  const s = await syncState();
  if (!tokenValid(s)) throw new Error("Google sign-in expired");
  const files = await listFiles(s.token);
  await pool(files.map(f => () => call(s.token, `${API}/files/${f.id}`, { method: "DELETE" })), 4);
  await setState({ lastSync: null, lastResult: null });
  return files.length;
}
