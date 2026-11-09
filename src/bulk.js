// Bulk import from photos of you wearing clothes.
// Phone: strip metadata, hide faces, cut garments. Cloud (your key): label + match garments. You: confirm in one list.
import { normalize } from "./images.js";
import { loadSegmenter, blobToCanvas, parseClothes, hideFaces, cutRegion, analyzePeople, isolatePerson, candidateNear } from "./vision.js";
import { labelPhoto, matchGarments } from "./claude.js";

// Phones have far less memory for the model than computers.
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const MAX_PHOTOS = MOBILE ? 30 : 60;
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export async function openBulk(ctx) {
  const { sheet, db, setTab, esc } = ctx;
  const api = await db.kvGet("anthropic", null);
  if (!api?.key) {
    sheet(`<h2>Import from your photos</h2>
      <p class="small">This needs your own Anthropic API key, saved only on this phone. Add it in Settings → Cloud labeling.</p>
      <button class="btn primary" id="go">Open Settings</button>`, (el, close) => (el.querySelector("#go").onclick = () => { close(); setTab("settings"); }));
    return;
  }
  sheet(`<h2>Import from your photos</h2>
    <p class="small">Pick up to ${MAX_PHOTOS} photos of you wearing clothes. On this phone: location data is removed, faces are hidden, and each garment is cut out.
    Only the face-hidden photo is sent to Claude to name and match the garments. Your original photos are not stored in the app.</p>
    <p class="small">Solo and mirror photos work best. In group photos you tap on yourself once; everyone else is greyed out before anything is sent.</p>
    <p class="small">First run downloads the clothes model (about 30 MB). Wi-Fi recommended. If the app closes midway, finished photos are kept and you can review them.</p>
    <label class="btn primary">Choose photos<input id="bulk" type="file" accept="image/*" multiple class="hidden"></label>`, (el, close) => {
    el.querySelector("#bulk").onchange = e => {
      const files = [...e.target.files].slice(0, MAX_PHOTOS);
      close();
      if (files.length) run(ctx, files, api);
    };
  });
}

async function run(ctx, files, api) {
  const { sheet, cfg, logEvent, toast } = ctx;
  const t0 = performance.now();
  logEvent("capture_started", { channel: "bulk", photos: files.length });
  let msgEl, stop = false, closeProgress;
  const openProgress = () => (closeProgress = sheet(`<h2>Finding your clothes</h2><p class="sub" id="msg">Starting…</p><div class="bar"><i id="pb" style="width:0%"></i></div>
    <p class="small">Keep this screen open. You can cancel any time; nothing is added until you confirm.</p><button class="btn" id="cancel">Cancel</button>`, el => {
    msgEl = el; el.querySelector("#cancel").onclick = () => { stop = true; };
  }));
  openProgress();
  const say = (m, f) => { msgEl.querySelector("#msg").textContent = m; if (f != null) msgEl.querySelector("#pb").style.width = Math.round(f * 100) + "%"; };
  const categories = Object.keys(cfg.categories);
  const entries = [], failures = [], deferred = [];
  let skippedTouching = 0, done = 0;
  const SESSION = "bulk:session";
  await ctx.db.kvSet(SESSION, { startedAt: new Date().toISOString(), total: files.length, done: 0, entries: [] });

  // Label + cut one photo whose person is already chosen. Only this face-hidden, single-person image leaves the device.
  const processPhoto = async (i, canvas, parsed, analysis, cand) => {
    isolatePerson(canvas, parsed, analysis, cand);
    if ((await hideFaces(canvas, parsed)) < 0) { failures.push({ photo: i + 1, error: "No person found" }); return; }
    say(`Photo ${i + 1} of ${files.length}: naming garments`);
    const b64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const { garments = [] } = await labelPhoto(api.key, api.model || DEFAULT_MODEL, b64, categories);
    const cuts = {};
    for (const g of ["upper", "lower", "shoes"]) cuts[g] = await cutRegion(canvas, parsed, g);
    garments.forEach((g, j) => {
      if (!cfg.categories[g.category]) return;
      const slot = cfg.categories[g.category].slot;
      const region = slot === "bottom" ? "lower" : slot === "shoes" ? "shoes" : g.outermost ? "upper" : null;
      const cut = region ? cuts[region] : null;
      entries.push({ key: `p${i}g${j}`, photo: i, date: files[i].lastModified, category: g.category, color: g.color || "", description: g.description || "",
        visibility: g.visibility, crop: cut?.blob || null, area: cut?.area || 0, group: analysis.candidates.length > 1 });
    });
    done++;
    await ctx.db.kvSet(SESSION, { startedAt: new Date().toISOString(), total: files.length, done, entries });
  };
  const load = async i => {
    const canvas = await blobToCanvas(await normalize(files[i]));
    const parsed = await parseClothes(canvas);
    return { canvas, parsed, analysis: analyzePeople(parsed) };
  };

  try {
    say("Downloading the clothes model…", 0);
    await loadSegmenter(f => say(`Downloading the clothes model… ${Math.round(f * 100)}%`, f * 0.15));
    // Pass 1: solo photos go straight through; group photos wait for "This is me".
    for (let i = 0; i < files.length && !stop; i++) {
      say(`Photo ${i + 1} of ${files.length}: looking for people`, 0.15 + 0.6 * (i / files.length));
      try {
        const { canvas, parsed, analysis } = await load(i);
        const n = analysis.candidates.length;
        if (!n) failures.push({ photo: i + 1, error: "No person found" });
        else if (analysis.merged) skippedTouching++;
        else if (n === 1) await processPhoto(i, canvas, parsed, analysis, analysis.candidates[0]);
        else {
          const t = document.createElement("canvas"), k = 360 / Math.max(canvas.width, canvas.height);
          t.width = Math.round(canvas.width * k); t.height = Math.round(canvas.height * k);
          t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
          deferred.push({ i, w: canvas.width, h: canvas.height, thumb: t.toDataURL("image/jpeg", 0.8), boxes: analysis.candidates.map(c => c.box) });
        }
        canvas.width = 0;
      } catch (e) { failures.push({ photo: i + 1, error: e.message }); console.warn(e); if (/401|authentication|invalid x-api-key/i.test(e.message)) break; }
    }
    if (stop) { closeProgress(); toast("Import cancelled. Nothing was added."); logEvent("capture_abandoned", { stage: "bulk" }); return; }
    // "This is me": one tap per group photo.
    if (deferred.length) {
      closeProgress();
      const picks = await pickPeople(ctx, deferred);
      logEvent("bulk_people_picked", { groupPhotos: deferred.length, skipped: picks.filter(p => p == null).length });
      openProgress();
      for (let k = 0; k < deferred.length && !stop; k++) {
        const d = deferred[k], box = picks[k] != null ? d.boxes[picks[k]] : null;
        if (!box) continue;
        say(`Group photo ${k + 1} of ${deferred.length}`, 0.75 + 0.15 * (k / deferred.length));
        try {
          const { canvas, parsed, analysis } = await load(d.i);
          const cand = candidateNear(analysis, box);
          if (cand) await processPhoto(d.i, canvas, parsed, analysis, cand); else failures.push({ photo: d.i + 1, error: "Could not find the chosen person again" });
          canvas.width = 0;
        } catch (e) { failures.push({ photo: d.i + 1, error: e.message }); }
      }
    }
    say("Matching the same garment across photos…", 0.92);
    const groups = await matchAll(api, entries, failures);
    closeProgress();
    logEvent("bulk_processed", { photos: files.length, garments: entries.length, groups: groups.length, failures: failures.length, groupPhotos: deferred.length, skippedTouching, ms: Math.round(performance.now() - t0) });
    if (skippedTouching) failures.push({ photo: "group", error: `${skippedTouching} group photo(s) skipped: people too close to separate` });
    pieceCheck(ctx, entries, groups, failures, files.length);
  } catch (e) {
    closeProgress(); toast("Import stopped: " + e.message); logEvent("capture_abandoned", { stage: "bulk", error: e.message.slice(0, 80) });
  }
}

// One screen for all group photos. Largest person is preselected; tap another outline to change, or skip the photo.
function pickPeople(ctx, deferred) {
  const { sheet } = ctx;
  const picks = deferred.map(() => 0);
  return new Promise(resolve => {
    const box = (d, b, j) => `<button data-p="${j}" aria-label="Person ${j + 1}" style="position:absolute;left:${b.x0 / d.w * 100}%;top:${b.y0 / d.h * 100}%;width:${(b.x1 - b.x0) / d.w * 100}%;height:${(b.y1 - b.y0) / d.h * 100}%;border:3px solid #fff;border-radius:10px;background:rgba(255,255,255,.12);box-shadow:0 0 0 2px rgba(0,0,0,.4);cursor:pointer"></button>`;
    sheet(`<h2>Tap yourself in ${deferred.length} group photo${deferred.length > 1 ? "s" : ""}</h2>
      <p class="small">Only the person you choose is used; everyone else is greyed out before sending. The largest person is chosen to start with.</p>
      ${deferred.map((d, k) => `<div data-k="${k}" style="display:flex;flex-direction:column;gap:6px">
        <div style="position:relative;align-self:center;max-width:100%"><img alt="Group photo ${k + 1}" src="${d.thumb}" style="display:block;max-width:100%;max-height:52vh;border-radius:12px">${d.boxes.map((b, j) => box(d, b, j)).join("")}</div>
        <div class="row"><span class="small" data-lbl>Person 1 chosen</span><button class="link muted" data-skip>Skip this photo</button></div></div>`).join("")}
      <button class="btn primary" id="go">Continue</button>`, (el, close) => {
      const paint = k => {
        const wrap = el.querySelector(`[data-k="${k}"]`);
        wrap.querySelectorAll("[data-p]").forEach(b => { const on = +b.dataset.p === picks[k]; b.style.borderColor = on ? "var(--accent)" : "#fff"; b.style.background = on ? "rgba(76,194,181,.25)" : "rgba(255,255,255,.12)"; });
        wrap.querySelector("[data-lbl]").textContent = picks[k] == null ? "Skipped" : `Person ${picks[k] + 1} chosen`;
      };
      deferred.forEach((d, k) => {
        const wrap = el.querySelector(`[data-k="${k}"]`);
        wrap.querySelectorAll("[data-p]").forEach(b => (b.onclick = () => { picks[k] = +b.dataset.p; paint(k); }));
        wrap.querySelector("[data-skip]").onclick = () => { picks[k] = null; paint(k); };
        paint(k);
      });
      el.querySelector("#go").onclick = () => { close(); resolve(picks); };
      el.parentElement.addEventListener("click", e => { if (e.target === el.parentElement) resolve(deferred.map(() => null)); });
    });
  });
}

async function matchAll(api, entries, failures) {
  let groups = entries.map(e => [e.key]);
  if (entries.length > 1) {
    try {
      const res = await matchGarments(api.key, api.model || DEFAULT_MODEL, entries.map(({ key, category, color, description }) => ({ key, category, color, description })));
      groups = sanitizeGroups(res.groups, entries);
    } catch (e) { failures.push({ photo: "matching", error: e.message }); }
  }
  return groups;
}

// Unfinished import (e.g. iOS closed the app): review what was saved.
export async function pendingBulk(ctx) {
  const s = await ctx.db.kvGet("bulk:session", null);
  return s && s.entries?.length ? s : null;
}
export async function resumeBulk(ctx) {
  const s = await pendingBulk(ctx);
  const api = await ctx.db.kvGet("anthropic", null);
  if (!s) return;
  if (!api?.key) { ctx.toast("Add your API key in Settings to finish matching"); return; }
  const failures = [];
  const groups = await matchAll(api, s.entries, failures);
  pieceCheck(ctx, s.entries, groups, failures, s.done);
}
export async function discardBulk(ctx) { await ctx.db.del("kv", "bulk:session"); }

// Every key exactly once; unknown keys dropped; missing keys become their own group; groups never mix slots.
export function sanitizeGroups(groups, entries) {
  const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
  const seen = new Set(), out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const keep = (Array.isArray(g) ? g : []).filter(k => byKey[k] && !seen.has(k));
    if (!keep.length) continue;
    keep.forEach(k => seen.add(k));
    out.push(keep);
  }
  for (const e of entries) if (!seen.has(e.key)) out.push([e.key]);
  return out;
}

function pieceCheck(ctx, entries, groups, failures, nPhotos) {
  const { sheet, cfg, esc, db, state, uid, nowISO, localDate, logEvent, render, toast } = ctx;
  const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
  const cards = groups.map((g, gi) => {
    const members = g.map(k => byKey[k]);
    const best = [...members].sort((a, b) => b.area - a.area)[0];
    const counts = {};
    members.forEach(m => (counts[m.category] = (counts[m.category] || 0) + 1));
    const category = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const photos = new Set(members.map(m => m.photo)).size;
    return { gi, members, best, category, photos, include: !!best.crop, url: best.crop ? URL.createObjectURL(best.crop) : null };
  }).sort((a, b) => (b.include - a.include) || (b.photos - a.photos));
  const opts = sel => Object.entries(cfg.categories).map(([k, c]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${c.label}</option>`).join("");
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  sheet(`<div class="row"><h2>Found ${cards.length} garments in ${nPhotos} photos</h2></div>
    <p class="small">Uncheck anything wrong. Items without a clear cut-out start unchecked; you can photograph them later.</p>
    ${failures.length ? `<p class="small warm">${failures.map(f => esc(typeof f.photo === "number" ? `Photo ${f.photo}: ${f.error}` : f.error)).join("<br>")}</p>` : ""}
    <div class="list">${cards.map(c => `<div class="li" style="align-items:flex-start;padding:8px 0">
      <label style="display:flex;gap:12px;align-items:flex-start;flex:1;min-width:0">
        <input type="checkbox" data-inc="${c.gi}" ${c.include ? "checked" : ""} style="width:24px;height:24px;margin-top:20px;flex:none">
        <span class="tile" style="width:72px;flex:none"><span class="img">${c.url ? `<img alt="" src="${c.url}">` : '<span class="ph">No clear photo</span>'}</span></span>
        <span style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <b style="font-size:15px">${esc(cap(c.best.color))} ${esc(cfg.categories[c.category].label.toLowerCase())}</b>
          <span class="small">${esc(c.best.description)}</span>
          <span class="small">In ${c.photos} photo${c.photos > 1 ? "s" : ""}</span>
          ${c.members.every(m => m.group) ? '<span class="small">From group photos only</span>' : ""}
          <select data-cat="${c.gi}" style="min-height:36px">${opts(c.category)}</select>
        </span></label></div>`).join("")}</div>
    <label class="li" style="gap:12px"><span class="small">Also log these as worn on the photo dates</span><input type="checkbox" id="logdays" style="width:24px;height:24px"></label>
    <button class="btn primary" id="add">Add selected items</button>`, (el, close) => {
    el.querySelector("#add").onclick = async () => {
      const chosen = cards.filter(c => el.querySelector(`[data-inc="${c.gi}"]`).checked);
      const idByGroup = {};
      for (const c of chosen) {
        const category = el.querySelector(`[data-cat="${c.gi}"]`).value;
        let photoId = null;
        if (c.best.crop) { photoId = uid(); await db.put("photos", { id: photoId, original: c.best.crop, cutout: c.best.crop, createdAt: nowISO(), source: "bulk" }); }
        const item = { id: uid(), category, name: cap(`${c.best.color} ${cfg.categories[category].label.toLowerCase()}`).slice(0, 60), description: c.best.description,
          photoId, status: "clean", source: "bulk", createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null };
        await db.put("items", item); state.items.push(item); idByGroup[c.gi] = item.id;
      }
      let days = 0;
      if (el.querySelector("#logdays").checked) {
        const perDate = {};
        for (const c of chosen) for (const m of c.members) {
          const d = localDate(new Date(m.date));
          (perDate[d] ||= new Set()).add(idByGroup[c.gi]);
        }
        for (const [d, ids] of Object.entries(perDate)) {
          if (d >= localDate() || state.wears.some(w => w.date === d)) continue;
          const w = { id: uid(), date: d, itemIds: [...ids], outerClosed: null, source: "bulk-photo-date", createdAt: nowISO(), updatedAt: nowISO() };
          await db.put("wears", w); state.wears.push(w); days++;
        }
      }
      await db.kvSet("suggest:" + localDate(), null);
      logEvent("bulk_import_done", { found: cards.length, added: chosen.length, days });
      cards.forEach(c => c.url && URL.revokeObjectURL(c.url));
      await db.del("kv", "bulk:session");
      close(); toast(`Added ${chosen.length} items${days ? `, ${days} days logged` : ""}`); render();
    };
  });
}
