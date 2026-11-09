import * as db from "./db.js";
import { fetchForecast } from "./weather.js";
import { normalize, removeBackground } from "./images.js";
import { applyTokens } from "./tokens.js";
import { S } from "./strings.js";
import { openBulk, DEFAULT_MODEL, pendingBulk, resumeBulk, discardBulk } from "./bulk.js";
import { testKey } from "./claude.js";
import { recommend, alternatives, personalOffset, summarizeWindow, starterProgress } from "../shared/engine.js";

const APP_VERSION = "0.7.1", SCHEMA = 1, PLATFORM = "web";
const DEFAULT_LOC = { lat: 32.08, lon: 34.78, city: "Tel Aviv" };
let cfg, state = { tab: "today", items: [], wears: [], ratings: [], settings: null, forecast: null };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();
const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const deg = v => (v == null ? "–" : Math.round(v) + "°");
const slotOf = i => cfg.categories[i.category]?.slot;
const itemById = id => state.items.find(i => i.id === id);

// ---------- events (same dictionary as the spec) ----------
function logEvent(name, props = {}) {
  db.put("events", { id: uid(), name, ts: nowISO(), tz: tz(), props, platform: PLATFORM, appVersion: APP_VERSION, schemaVersion: SCHEMA }).catch(() => {});
}

// ---------- load ----------
async function load() {
  [state.items, state.wears, state.ratings] = await Promise.all([db.all("items"), db.all("wears"), db.all("ratings")]);
  state.items = state.items.filter(i => !i.deletedAt);
  state.settings = { workDays: [0, 1, 2, 3, 4], longPantsAtWork: false,
    ...(await db.kvGet("settings", { leave: "07:30", back: "19:00", ...DEFAULT_LOC, locSource: "default", lastPlace: "Outside shade", lastMinutes: 20 })) };
  state.forecast = await db.kvGet("forecast", null);
  state.apiKeySet = !!(await db.kvGet("anthropic", null))?.key;
}
async function saveSettings(patch) { state.settings = { ...state.settings, ...patch }; await db.kvSet("settings", state.settings); }

async function getForecast(force = false) {
  const f = state.forecast, s = state.settings;
  const fresh = f && f.lat === s.lat && f.lon === s.lon && Date.now() - Date.parse(f.fetchedAt) < 3 * 3600e3;
  if (fresh && !force) return f;
  try {
    const nf = { ...(await fetchForecast(s.lat, s.lon)), lat: s.lat, lon: s.lon };
    state.forecast = nf; await db.kvSet("forecast", nf);
  } catch { logEvent("forecast_stale", { ageH: f ? Math.round((Date.now() - Date.parse(f.fetchedAt)) / 3600e3) : null }); }
  return state.forecast;
}

// ---------- photos ----------
const urlCache = {};
async function photoURL(photoId, cutout = true) {
  if (!photoId) return null;
  const key = photoId + (cutout ? ":c" : ":o");
  if (urlCache[key]) return urlCache[key];
  const p = await db.get("photos", photoId);
  if (!p) return null;
  const blob = (cutout && p.cutout) || p.original;
  return (urlCache[key] = URL.createObjectURL(blob));
}
async function hydrateImages(root = document) {
  for (const el of root.querySelectorAll("[data-photo]")) {
    const u = await photoURL(el.dataset.photo);
    if (u) el.innerHTML = `<img alt="" src="${u}">`;
  }
}
function tileHTML(item, meta, attrs = "") {
  const label = esc(item.name || cfg.categories[item.category]?.label || "Item");
  return `<button class="tile" ${attrs}><span class="img" data-photo="${esc(item.photoId || "")}"><span class="ph">${label}</span>${item.processing ? '<span class="badge">Processing</span>' : ""}</span><span class="name">${label}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</button>`;
}

// ---------- engine glue ----------
const isWorkDay = (d = new Date()) => state.settings.workDays.includes(d.getDay());
function engineInput(extra = {}) {
  const w = state.forecast && summarizeWindow(state.forecast.hourly, localDate(), state.settings.leave, state.settings.back);
  return { items: state.items, window: w || { minFeelsC: 20, maxFeelsC: 24 }, windowKnown: !!w, offsetC: personalOffset(state.ratings, cfg), today: localDate(),
    wears: state.wears.map(x => ({ date: x.date, itemIds: x.itemIds })),
    constraints: { longPants: state.settings.longPantsAtWork && isWorkDay() }, ...extra };
}
async function todaySuggestion(reset = false) {
  const key = "suggest:" + localDate();
  let s = reset ? null : await db.kvGet(key, null);
  if (s && s.app === APP_VERSION && s.outfit && Object.values(s.outfit).every(id => !id || itemById(id))) return s;
  const r = recommend(engineInput({ exclude: s?.exclude || [] }), cfg);
  s = { ...r, exclude: s?.exclude || [], app: APP_VERSION };
  await db.kvSet(key, s);
  if (r.status === "ok") logEvent("outfit_shown", { surface: "app", effC: r.effC, required: r.requiredWarmth });
  return s;
}
const lastWorn = id => state.wears.filter(w => w.itemIds.includes(id)).map(w => w.date).sort().pop();
function wornMeta(id) {
  const d = lastWorn(id);
  if (!d) return "Not worn yet";
  const n = Math.round((Date.parse(localDate()) - Date.parse(d)) / 864e5);
  return n === 0 ? "Today" : n === 1 ? "Yesterday" : n < 7 ? `${n} days ago` : `${Math.round(n / 7)} wk ago`;
}

// ---------- UI shell ----------
function toast(msg, undo) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast"; t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button>${S.undo}</button>` : ""}`;
  document.body.append(t);
  if (undo) t.querySelector("button").onclick = () => { t.remove(); undo(); };
  setTimeout(() => t.remove(), 5000);
}
function sheet(html, mount) {
  const sc = document.createElement("div");
  sc.className = "scrim";
  sc.innerHTML = `<section class="sheet" role="dialog" aria-modal="true"><span class="grabber"></span>${html}</section>`;
  sc.addEventListener("click", e => { if (e.target === sc) close(); });
  const close = () => sc.remove();
  document.body.append(sc);
  mount?.(sc.querySelector(".sheet"), close);
  return close;
}
function setTab(t) { state.tab = t; render(); window.scrollTo(0, 0); }
async function render() {
  for (const b of document.querySelectorAll("nav.tabs button")) b.setAttribute("aria-current", b.dataset.tab === state.tab ? "page" : "false");
  const m = $("main");
  if (state.tab === "today") await renderToday(m);
  else if (state.tab === "closet") renderCloset(m);
  else if (state.tab === "history") renderHistory(m);
  else if (state.tab === "settings") renderSettings(m);
  hydrateImages(m);
}

const ctx = () => ({ sheet, toast, db, cfg, state, render, setTab, logEvent, uid, nowISO, localDate, esc });
const bulk = () => openBulk(ctx());

// ---------- Today ----------
async function bulkBanner(m) {
  const pend = await pendingBulk(ctx());
  if (!pend) return;
  const d = document.createElement("section");
  d.className = "card";
  d.innerHTML = `<h2>Unfinished photo import</h2><p class="small">${pend.done} of ${pend.total} photos were processed before the app closed. Review them now, or discard.</p>
    <button class="btn primary" id="bk-r">Review ${pend.done} photos</button><button class="btn" id="bk-d">Discard</button>`;
  m.querySelector("header").after(d);
  d.querySelector("#bk-r").onclick = () => resumeBulk(ctx());
  d.querySelector("#bk-d").onclick = async () => { await discardBulk(ctx()); render(); };
}
async function renderToday(m) {
  await renderTodayInner(m);
  await bulkBanner(m);
}
async function renderTodayInner(m) {
  const s = state.settings, p = starterProgress(state.items, cfg);
  const head = `<header><div class="sub">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · ${esc(s.city || "Saved place")}</div><h1>${S.today}</h1></header>`;
  if (!p.ready) {
    const row = (l, [a, b]) => `<div class="li"><span>${l}</span><span class="${a >= b ? "acc" : "small"}">${a} of ${b}</span></div>`;
    m.innerHTML = `${head}<section class="card"><h2>${S.starterTitle(p.total, p.goal)}</h2><div class="bar"><i style="width:${Math.min(100, p.total / p.goal * 100)}%"></i></div>
      <div class="list">${row("Tops", p.base)}${row("Bottoms", p.bottom)}${row("Shoes", p.shoes)}${row("Outer layer", p.outer)}</div>
      <button class="btn primary" id="go-bulk">Import from my outfit photos</button>
      <button class="btn" id="go-add">Add one by one</button></section>
      <p class="small">Shoot what you wear this week. Your first outfit appears once you have a top, a bottom and shoes.</p>`;
    $("#go-add").onclick = openAdd;
    $("#go-bulk").onclick = bulk;
    return;
  }
  const f = await getForecast();
  const sug = await todaySuggestion();
  const w = f && summarizeWindow(f.hourly, localDate(), s.leave, s.back);
  const wornToday = state.wears.find(x => x.date === localDate());
  let outfitHTML = "";
  if (sug.status === "incomplete" && sug.missing?.includes("long pants"))
    outfitHTML = `<section class="card"><h2>No long pants available</h2><p class="small">Today is a work day and your closet has no long pants that are clean. Add some, or mark a pair as clean.</p></section>`;
  if (sug.status === "ok") {
    const o = sug.outfit, order = ["outer", "mid", "base", "bottom", "shoes"].filter(k => o[k]);
    const tiles = order.map(k => tileHTML(itemById(o[k]), k === "outer" && sug.outerClosed != null ? (sug.outerClosed ? "Wear it closed" : "Open is fine") : null, `data-slot="${k}"`)).join("");
    const work = state.settings.longPantsAtWork && isWorkDay();
    outfitHTML = `<section class="card"><div class="row"><h2>Today's outfit</h2><span class="small">${work ? "Work day · long pants" : S.tapSwap}</span></div>
      <div class="grid2">${tiles}</div>
      ${sug.shortfall > 0 ? `<p class="small warm">Your closet is short on warm layers for ${deg(sug.effC)}. Add a sweater or jacket.</p>` : ""}
      ${wornToday ? `<div class="row"><span class="acc">✓ ${S.loggedToday}</span><button class="link muted" id="unwear">${S.undo}</button></div>`
        : `<button class="btn primary" id="wear">${S.wearing}</button><button class="btn" id="another">${S.another}</button>`}</section>`;
  }
  const age = f ? (Date.now() - Date.parse(f.fetchedAt)) / 3600e3 : null;
  const wx = w ? `<div class="wx"><span><b>${deg(w.minFeelsC)}–${deg(w.maxFeelsC)}</b> <span class="small">Morning <b class="cold">${deg(w.morningC)}</b> · Midday <b class="warm">${deg(w.middayC)}</b> · Evening <b class="cold">${deg(w.eveningC)}</b></span></span></div>`
    : `<div class="wx"><span class="small">No forecast yet</span><button class="link" id="refresh">${S.refresh}</button></div>`;
  const stale = age != null && age > 3 ? `<div class="wx"><span class="small">${S.offline(new Date(f.fetchedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</span><button class="link" id="refresh">${S.refresh}</button></div>` : "";
  m.innerHTML = `${head}${outfitHTML}${wx}${stale}
    <section class="card"><div class="row"><h2>${S.howFeel}</h2></div><p class="small">Rate after at least 15 minutes in the same place. Every rating tunes your suggestions.</p><button class="btn" id="rate">${S.rateNow}</button></section>
    ${s.locSource === "default" ? `<div class="li row"><span class="small">Location not set · using Tel Aviv</span><button class="link" id="setloc">${S.change}</button></div>` : ""}`;
  m.querySelectorAll("[data-slot]").forEach(b => (b.onclick = () => openSwap(sug, b.dataset.slot)));
  $("#wear") && ($("#wear").onclick = () => wear(sug));
  $("#another") && ($("#another").onclick = another);
  $("#unwear") && ($("#unwear").onclick = async () => { await db.del("wears", wornToday.id); state.wears = state.wears.filter(x => x.id !== wornToday.id); logEvent("wear_undone"); render(); });
  $("#refresh") && ($("#refresh").onclick = async () => { await getForecast(true); await todaySuggestion(true); render(); });
  $("#rate").onclick = openComfort;
  $("#setloc") && ($("#setloc").onclick = () => setTab("settings"));
}
async function wear(sug) {
  const ids = Object.values(sug.outfit).filter(Boolean);
  const w = { id: uid(), date: localDate(), itemIds: ids, outerClosed: sug.outerClosed, source: "suggestion", createdAt: nowISO(), updatedAt: nowISO() };
  await db.put("wears", w); state.wears.push(w);
  logEvent("outfit_accepted", { surface: "app" }); logEvent("wear_logged", { source: "app" });
  render();
}
async function another() {
  const cur = await todaySuggestion();
  const exclude = [...(cur.exclude || []), cur.outfit.base, cur.outfit.mid, cur.outfit.outer].filter(Boolean);
  let r = recommend(engineInput({ exclude }), cfg);
  let ex = exclude;
  if (r.status !== "ok") { ex = []; r = recommend(engineInput(), cfg); }
  await db.kvSet("suggest:" + localDate(), { ...r, exclude: ex, app: APP_VERSION });
  logEvent("outfit_regenerated");
  render();
}
async function openSwap(sug, slot) {
  const alts = alternatives(engineInput(), sug.outfit, slot, cfg);
  const cur = itemById(sug.outfit[slot]);
  const rows = alts.map(a => { const it = itemById(a.id); return `<button class="tile" data-id="${a.id}" style="flex-direction:row;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:10px 12px">
    <span class="img" style="width:64px;flex:none" data-photo="${esc(it.photoId || "")}"><span class="ph">${esc(it.name || cfg.categories[it.category].label)}</span></span>
    <span style="display:flex;flex-direction:column;gap:2px"><span class="name">${esc(it.name || cfg.categories[it.category].label)}</span><span class="meta">${a.fits ? "Fits today" : "Lighter than today needs"} · ${wornMeta(it.id)}</span></span></button>`; }).join("");
  sheet(`<h2>Swap ${esc(cur?.name || slot)}</h2><p class="small">The rest of the outfit stays. Tap to swap now.</p>${rows || '<p class="small">No other items for this slot yet.</p>'}`, (el, close) => {
    hydrateImages(el);
    el.querySelectorAll("[data-id]").forEach(b => (b.onclick = async () => {
      const prev = { ...sug };
      const fixed = { ...sug.outfit, [slot]: b.dataset.id };
      const r = recommend(engineInput({ fixed }), cfg);
      await db.kvSet("suggest:" + localDate(), { ...r, exclude: sug.exclude || [], app: APP_VERSION });
      logEvent("outfit_swapped", { slot });
      close(); render();
      toast("Swapped", async () => { await db.kvSet("suggest:" + localDate(), prev); render(); });
    }));
  });
}

// ---------- Comfort check ----------
async function openComfort() {
  logEvent("comfort_prompt_shown", { surface: "app" });
  const s = state.settings, wornToday = state.wears.find(x => x.date === localDate());
  const sug = await db.kvGet("suggest:" + localDate(), null);
  const ids = wornToday?.itemIds || (sug?.outfit ? Object.values(sug.outfit).filter(Boolean) : []);
  const outerId = ids.find(id => slotOf(itemById(id) || {}) === "outer");
  const clothes = ids.map(id => itemById(id)?.name || cfg.categories[itemById(id)?.category]?.label).filter(Boolean).join(", ") || "Not logged";
  const r = { sensation: null, preference: "", place: s.lastPlace, minutes: s.lastMinutes, outerState: outerId ? (wornToday?.outerClosed === false ? "open" : "closed") : "none" };
  const chips = (name, opts, val) => `<div class="chips" data-group="${name}">${opts.map(([l, v]) => `<button class="chip" data-v="${esc(v)}" aria-pressed="${String(v) === String(val)}">${esc(l)}</button>`).join("")}</div>`;
  sheet(`<div class="row"><h2>${S.howFeel}</h2><button class="link muted" id="skip">${S.skip}</button></div>
    <div class="scale" id="scale">${S.scale.map(([l, v]) => `<button data-v="${v}" class="${v < 0 ? "cold" : v > 0 ? "warm" : "acc"}">${l}</button>`).join("")}</div>
    <div id="step2" class="hidden" style="display:flex;flex-direction:column;gap:12px">
      <div id="pref"><div class="sub">${S.rather}</div>${chips("preference", S.prefs, "")}</div>
      <div><div class="sub">${S.place}</div>${chips("place", S.places.map(p => [p, p]), r.place)}</div>
      <div><div class="sub">${S.timeHere}</div>${chips("minutes", S.minutes, r.minutes)}</div>
      <div><div class="sub">${S.wearingNow}: ${esc(clothes)}</div>${outerId ? chips("outerState", [["Outer layer closed", "closed"], ["Outer layer open", "open"]], r.outerState) : ""}</div>
      <button class="btn primary" id="save">${S.save}</button></div>`, (el, close) => {
    el.querySelector("#skip").onclick = () => { logEvent("comfort_prompt_dismissed"); close(); };
    el.querySelectorAll("#scale button").forEach(b => (b.onclick = () => {
      r.sensation = +b.dataset.v;
      el.querySelectorAll("#scale button").forEach(x => (x.style.outline = x === b ? "2px solid var(--accent)" : ""));
      el.querySelector("#step2").classList.remove("hidden");
      el.querySelector("#pref").classList.toggle("hidden", r.sensation === 0);
      if (r.sensation === 0) r.preference = "no change";
    }));
    el.querySelectorAll("[data-group]").forEach(g => g.querySelectorAll(".chip").forEach(c => (c.onclick = () => {
      g.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(x === c)));
      const v = c.dataset.v; r[g.dataset.group] = g.dataset.group === "minutes" ? +v : v;
    })));
    el.querySelector("#save").onclick = async () => {
      let weather = null, lat = null, lon = null;
      try { const f = await fetchForecast(s.lat, s.lon); weather = f.current; } catch {}
      if (s.locSource !== "default") { lat = Math.round(s.lat * 100) / 100; lon = Math.round(s.lon * 100) / 100; }
      const rating = { id: uid(), ts: nowISO(), tz: tz(), sensation: r.sensation, preference: r.preference, place: r.place, minutesInPlace: r.minutes,
        outerState: r.outerState, itemIds: ids, clothesText: clothes, weather, lat, lon, source: "app", createdAt: nowISO(), updatedAt: nowISO() };
      await db.put("ratings", rating); state.ratings.push(rating);
      await saveSettings({ lastPlace: r.place, lastMinutes: r.minutes });
      logEvent("comfort_rated", { sensation: r.sensation, preference: r.preference, place: r.place, minutes: r.minutes });
      close(); toast(`Saved · offset now ${personalOffset(state.ratings, cfg).toFixed(1)}°`); render();
    };
  });
}

// ---------- Closet ----------
function renderCloset(m) {
  const filter = state.closetFilter || "all";
  const groups = [["all", "All"], ["base", "Tops"], ["mid", "Mid layers"], ["outer", "Outer"], ["bottom", "Bottoms"], ["shoes", "Shoes"]];
  const list = state.items.filter(i => filter === "all" || slotOf(i) === filter).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  m.innerHTML = `<header class="row"><div><h1>${S.closet}</h1><div class="sub">${state.items.length} items</div></div>
    <div class="row"><button class="chip" id="more" aria-label="Settings">···</button><button class="btn primary" id="add" style="min-height:44px;width:auto;padding:0 16px">+ Add</button></div></header>
    <div class="chips" style="flex-wrap:nowrap;overflow-x:auto">${groups.map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${k === filter}">${l}</button>`).join("")}</div>
    ${list.length ? `<div class="grid3">${list.map(i => tileHTML(i, i.status === "laundry" ? S.laundry : wornMeta(i.id), `data-id="${i.id}"`)).join("")}</div>` : `<p class="small">Nothing here yet.</p>`}`;
  $("#add").onclick = openAdd;
  $("#more").onclick = () => setTab("settings");
  m.querySelectorAll("[data-f]").forEach(b => (b.onclick = () => { state.closetFilter = b.dataset.f; render(); }));
  m.querySelectorAll("[data-id]").forEach(b => (b.onclick = () => openItem(b.dataset.id)));
}
function openAdd() {
  logEvent("capture_started", { channel: "picker" });
  sheet(`<h2>${S.addItems}</h2><p class="small">Every photo is saved first, so nothing is lost. You pick what it is with one tap.</p>
    <label class="btn primary">${S.camera}<input id="cam" type="file" accept="image/*" capture="environment" class="hidden"></label>
    <label class="btn">${S.photos}<input id="lib" type="file" accept="image/*" multiple class="hidden"></label>
    <button class="btn" id="bulk">Import from my outfit photos</button>`, (el, close) => {
    el.querySelector("#bulk").onclick = () => { close(); bulk(); };
    const handle = async files => { close(); for (const f of files) await addPhoto(f); };
    el.querySelector("#cam").onchange = e => handle([...e.target.files]);
    el.querySelector("#lib").onchange = e => handle([...e.target.files]);
  });
}
async function addPhoto(file) {
  const t0 = performance.now();
  let blob;
  try { blob = await normalize(file); } catch (e) { toast(e.message); logEvent("capture_abandoned", { stage: "decode" }); return; }
  const photo = { id: uid(), original: blob, createdAt: nowISO() };
  await db.put("photos", photo);
  const category = await pickCategory(photo.id);
  if (!category) { logEvent("capture_abandoned", { stage: "category" }); return; }
  const item = { id: uid(), category, name: "", photoId: photo.id, status: "clean", createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null };
  await db.put("items", item); state.items.push(item);
  logEvent("item_saved", { category, ms: Math.round(performance.now() - t0) });
  await db.kvSet("suggest:" + localDate(), null);
  render();
}
function pickCategory(photoId) {
  return new Promise(resolve => {
    const bySlot = {};
    for (const [k, c] of Object.entries(cfg.categories)) (bySlot[c.slot] ||= []).push([k, c.label]);
    const names = { base: "Tops", mid: "Mid layers", outer: "Outer layers", bottom: "Bottoms", shoes: "Shoes" };
    let done = false;
    sheet(`<div class="row"><h2>${S.pickCategory}</h2><span class="tile" style="width:64px"><span class="img" data-photo="${photoId}"></span></span></div>
      ${Object.entries(bySlot).map(([sl, arr]) => `<div class="sub">${names[sl]}</div><div class="chips">${arr.map(([k, l]) => `<button class="chip" data-k="${k}">${l}</button>`).join("")}</div>`).join("")}`, (el, close) => {
      hydrateImages(el);
      el.querySelectorAll("[data-k]").forEach(b => (b.onclick = () => { done = true; close(); resolve(b.dataset.k); }));
      el.parentElement.addEventListener("click", e => { if (e.target === el.parentElement && !done) resolve(null); });
    });
  });
}
async function openItem(id) {
  const it = itemById(id);
  const opts = Object.entries(cfg.categories).map(([k, c]) => `<option value="${k}" ${k === it.category ? "selected" : ""}>${c.label}</option>`).join("");
  sheet(`<div class="tile"><span class="img" data-photo="${esc(it.photoId || "")}"></span></div>
    <input type="text" id="nm" placeholder="Name, e.g. Navy light jacket" value="${esc(it.name)}">
    <select id="cat">${opts}</select>
    <div class="chips"><button class="chip" id="st" aria-pressed="${it.status === "laundry"}">${S.laundry}</button></div>
    <button class="btn" id="bg">${S.removeBg}</button><p class="small hidden" id="bgp"></p>
    <button class="btn primary" id="sv">${S.save}</button><button class="btn danger" id="dl">${S.del}</button>`, (el, close) => {
    hydrateImages(el);
    el.querySelector("#st").onclick = e => e.target.setAttribute("aria-pressed", String(e.target.getAttribute("aria-pressed") !== "true"));
    el.querySelector("#bg").onclick = async () => {
      const p = await db.get("photos", it.photoId), msg = el.querySelector("#bgp");
      msg.classList.remove("hidden"); msg.textContent = S.removingBg + " First time downloads the model (about 45 MB).";
      const t0 = performance.now();
      try {
        p.cutout = await removeBackground(p.original, (k, f) => (msg.textContent = `${S.removingBg} downloading ${Math.round(f * 100)}%`));
        await db.put("photos", p); delete urlCache[p.id + ":c"];
        logEvent("background_removed", { ok: true, ms: Math.round(performance.now() - t0) });
        msg.textContent = "Done."; hydrateImages(el);
      } catch (e) { console.warn(e); logEvent("background_removed", { ok: false, error: String(e.message || e).slice(0, 80) }); msg.textContent = "Could not remove the background. The original photo is kept. (" + String(e.message || e).slice(0, 120) + ")"; }
    };
    el.querySelector("#sv").onclick = async () => {
      Object.assign(it, { name: el.querySelector("#nm").value.trim().slice(0, 60), category: el.querySelector("#cat").value,
        status: el.querySelector("#st").getAttribute("aria-pressed") === "true" ? "laundry" : "clean", updatedAt: nowISO() });
      await db.put("items", it); await db.kvSet("suggest:" + localDate(), null); close(); render();
    };
    el.querySelector("#dl").onclick = async () => {
      if (!confirm("Delete this item? Its history stays.")) return;
      it.deletedAt = nowISO(); await db.put("items", it); state.items = state.items.filter(x => x.id !== id);
      await db.kvSet("suggest:" + localDate(), null); close(); render();
    };
  });
}

// ---------- History ----------
function renderHistory(m) {
  const days = [...Array(14)].map((_, i) => localDate(new Date(Date.now() - i * 864e5)));
  const logged = days.filter(d => state.wears.some(w => w.date === d)).length;
  const notWorn = state.items.filter(i => !lastWorn(i.id)).length;
  const lastByDay = d => state.ratings.filter(r => localDate(new Date(r.ts)) === d).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  const rows = days.map((d, idx) => {
    const w = state.wears.find(x => x.date === d), r = lastByDay(d);
    const label = new Date(d + "T12:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
    const feel = r ? S.scale.find(([, v]) => v === r.sensation)?.[0] : "";
    const fcol = r ? (r.sensation < 0 ? "cold" : r.sensation > 0 ? "warm" : "acc") : "";
    if (w) return `<div class="li"><span style="width:64px"><b>${label}</b></span><span class="row" style="gap:6px;flex:1;justify-content:flex-start">${w.itemIds.map(id => itemById(id)).filter(Boolean).map(it => `<span class="tile" style="width:40px"><span class="img" data-photo="${esc(it.photoId || "")}"></span></span>`).join("")}</span><span class="small ${fcol}">${feel || ""}</span></div>`;
    const prev = state.wears.filter(x => x.date < d).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const canFill = idx > 0 && idx <= 3 && prev;
    return `<div class="li"><span style="width:64px"><b>${label}</b></span><span class="small" style="flex:1">${S.noLog}</span>${canFill ? `<button class="link" data-fill="${d}" data-from="${prev.id}">${S.sameAs(new Date(prev.date + "T12:00").toLocaleDateString("en-US", { weekday: "short" }))}</button>` : ""}</div>`;
  }).join("");
  m.innerHTML = `<header><div class="sub">Last 14 days</div><h1>${S.history}</h1></header>
    <div class="grid3"><div class="card" style="padding:10px 12px;gap:2px"><b style="font-size:22px">${logged} of 14</b><span class="small">days logged</span></div>
    <div class="card" style="padding:10px 12px;gap:2px"><b style="font-size:22px">${state.ratings.length}</b><span class="small">comfort ratings</span></div>
    <div class="card" style="padding:10px 12px;gap:2px"><b style="font-size:22px">${notWorn}</b><span class="small">not worn yet</span></div></div>
    <div class="list">${rows}</div>`;
  m.querySelectorAll("[data-fill]").forEach(b => (b.onclick = async () => {
    const src = state.wears.find(x => x.id === b.dataset.from);
    const w = { id: uid(), date: b.dataset.fill, itemIds: src.itemIds, outerClosed: src.outerClosed, source: "catch-up", createdAt: nowISO(), updatedAt: nowISO() };
    await db.put("wears", w); state.wears.push(w); logEvent("wear_logged", { source: "catch-up" }); render();
  }));
}

// ---------- Settings ----------
function renderSettings(m) {
  const s = state.settings, off = personalOffset(state.ratings, cfg);
  m.innerHTML = `<button class="link" id="back" style="align-self:flex-start">‹ ${S.closet}</button><h1>${S.settings}</h1>
    <div class="sub">YOUR DAY</div><section class="card list">
      <div class="li"><span>Leave home</span><input type="time" id="lv" value="${s.leave}"></div>
      <div class="li"><span>Back home</span><input type="time" id="bk" value="${s.back}"></div>
      <div class="li" style="flex-wrap:wrap"><span>Work days</span><span class="chips" id="wd">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<button class="chip" data-d="${i}" aria-pressed="${s.workDays.includes(i)}" style="min-height:36px;padding:0 10px">${d}</button>`).join("")}</span></div>
      <div class="li"><span>Long pants on work days</span><button class="chip" id="lp" aria-pressed="${s.longPantsAtWork}">${s.longPantsAtWork ? "On" : "Off"}</button></div>
      <div class="li"><span>Location</span><span class="row"><span class="small">${esc(s.city || `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`)}</span><button class="link" id="loc">Use my location</button></span></div></section>
    <div class="sub">COMFORT</div><section class="card list">
      <div class="li"><span>You run</span><span class="small">${off === 0 ? "about average" : `${Math.abs(off).toFixed(1)}° ${off < 0 ? "colder" : "warmer"} than average`} · ${state.ratings.length} ratings</span></div>
      <div class="li"><span>Reset what the app learned</span><button class="link" id="rst">Reset</button></div></section>
    <div class="sub">CLOUD LABELING (photo import)</div><section class="card list">
      <div class="li"><span>Anthropic API key</span><span class="row"><span class="small" id="keyst">${state.apiKeySet ? "Saved on this phone" : "Not set"}</span></span></div>
      <div class="li"><input type="password" id="apikey" placeholder="sk-ant-…" autocomplete="off" style="flex:1"><button class="link" id="savekey">Save</button></div>
      <div class="li"><span class="small">Use a dedicated workspace key with a low monthly limit. Only face-hidden photos are sent.</span>${state.apiKeySet ? '<button class="link muted" id="delkey">Remove</button>' : ""}</div></section>
    <div class="sub">YOUR DATA (stays on this phone)</div><section class="card list">
      <div class="li"><span>${S.export}</span><button class="link" id="ex">Export</button></div>
      <div class="li"><span>${S.import}</span><label class="link" style="display:flex;align-items:center">Import<input type="file" id="im" accept="application/json,.json" class="hidden"></label></div>
      <div class="li"><span class="warm">${S.deleteAll}</span><button class="link" id="da" style="color:var(--warm)">Delete</button></div></section>
    <p class="small">Version ${APP_VERSION} · schema ${SCHEMA}. Add to Home Screen so iOS keeps your data.</p>`;
  $("#back").onclick = () => setTab("closet");
  $("#lv").onchange = e => saveSettings({ leave: e.target.value }).then(() => db.kvSet("suggest:" + localDate(), null));
  $("#bk").onchange = e => saveSettings({ back: e.target.value }).then(() => db.kvSet("suggest:" + localDate(), null));
  m.querySelectorAll("#wd [data-d]").forEach(b => (b.onclick = async () => {
    const d = +b.dataset.d, set = new Set(state.settings.workDays);
    set.has(d) ? set.delete(d) : set.add(d);
    await saveSettings({ workDays: [...set].sort() }); await db.kvSet("suggest:" + localDate(), null); render();
  }));
  $("#lp").onclick = async () => { await saveSettings({ longPantsAtWork: !state.settings.longPantsAtWork }); await db.kvSet("suggest:" + localDate(), null); logEvent("settings_changed", { key: "longPantsAtWork" }); render(); };
  $("#loc").onclick = () => navigator.geolocation.getCurrentPosition(async p => {
    await saveSettings({ lat: p.coords.latitude, lon: p.coords.longitude, city: "Current location", locSource: "gps" });
    await getForecast(true); await db.kvSet("suggest:" + localDate(), null); render();
  }, () => toast("Location not allowed. Using the saved place."), { maximumAge: 3600e3, timeout: 10000 });
  $("#rst").onclick = async () => {
    if (!confirm("Reset the learned offset? Your ratings stay in History and export, but stop affecting suggestions.")) return;
    await saveSettings({ offsetResetAt: nowISO() }); state.ratings = state.ratings.filter(r => r.ts > state.settings.offsetResetAt); render();
  };
  $("#savekey").onclick = async () => {
    const key = $("#apikey").value.trim();
    if (!/^sk-ant-/.test(key)) { toast("That does not look like an Anthropic key"); return; }
    $("#keyst").textContent = "Checking…";
    try { await testKey(key, DEFAULT_MODEL); await db.kvSet("anthropic", { key, model: DEFAULT_MODEL }); state.apiKeySet = true; toast("Key works and is saved"); render(); }
    catch (e) { $("#keyst").textContent = "Not saved"; toast(e.message); }
  };
  $("#delkey") && ($("#delkey").onclick = async () => { await db.del("kv", "anthropic"); state.apiKeySet = false; render(); });
  $("#ex").onclick = exportAll;
  $("#im").onchange = e => importAll(e.target.files[0]);
  $("#da").onclick = async () => {
    if (!confirm("Delete all items, photos, history and ratings from this phone? This cannot be undone. Export first if you want a copy.")) return;
    for (const st of db.STORES) await db.clear(st);
    location.reload();
  };
}
const b64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
async function exportAll() {
  const [items, photos, wears, ratings, events] = await Promise.all(["items", "photos", "wears", "ratings", "events"].map(s => db.all(s)));
  const ph = [];
  for (const p of photos) ph.push({ id: p.id, createdAt: p.createdAt, original: await b64(p.original), cutout: p.cutout ? await b64(p.cutout) : null });
  const out = { format: "closet-export", schemaVersion: SCHEMA, exportedAt: nowISO(), platform: PLATFORM, appVersion: APP_VERSION,
    settings: state.settings, items, wears, ratings, events, photos: ph };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
  a.download = `closet-export-${localDate()}.json`; a.click();
  logEvent("export_done", { items: items.length, ratings: ratings.length });
}
async function importAll(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.format !== "closet-export" || j.schemaVersion > SCHEMA) throw new Error("Not a closet export from this version");
    const toBlob = async d => (d ? (await fetch(d)).blob() : null);
    for (const p of j.photos || []) await db.put("photos", { id: p.id, createdAt: p.createdAt, original: await toBlob(p.original), cutout: await toBlob(p.cutout) });
    for (const st of ["items", "wears", "ratings", "events"]) for (const r of j[st] || []) await db.put(st, r);
    if (j.settings) await db.kvSet("settings", j.settings);
    toast("Imported"); await load(); render();
  } catch (e) { toast("Import failed: " + e.message); }
}

// ---------- boot ----------
async function boot() {
  await applyTokens();
  cfg = await (await fetch("./shared/config.json")).json();
  await load();
  if (state.settings.offsetResetAt) state.ratings = state.ratings.filter(r => r.ts > state.settings.offsetResetAt);
  db.persist();
  document.querySelectorAll("nav.tabs button").forEach(b => (b.onclick = () => setTab(b.dataset.tab)));
  logEvent("app_open", { source: new URLSearchParams(location.search).get("src") || "icon" });
  if (new URLSearchParams(location.search).get("rate") === "1") setTimeout(openComfort, 300);
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
