// Outfit recommendation engine. Pure functions only: no network, no clock, no randomness.
// Every port (Swift, Kotlin) must pass shared/golden-tests.json.

const DAY_MS = 86400000;

export function requiredWarmth(effC, cfg) {
  for (const b of cfg.warmthBands) if (effC >= b.minFeelsC) return b.requiredUpperWarmth;
  return cfg.warmthBands[cfg.warmthBands.length - 1].requiredUpperWarmth;
}

// ratings: [{ ts, sensation (-3..3), preference: "warmer"|"no change"|"cooler"|"" }], newest last or any order.
// Returns a temperature offset in °C added to the forecast: negative = you feel colder than average.
export function personalOffset(ratings, cfg) {
  const { stepC, capC, lastNRatings } = cfg.personalOffset;
  const sorted = [...ratings].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = sorted.slice(-lastNRatings);
  let sum = 0;
  for (const r of recent) {
    if (r.preference === "warmer") sum -= stepC;
    else if (r.preference === "cooler") sum += stepC;
  }
  return Math.max(-capC, Math.min(capC, sum));
}

// hourly: [{ time: "YYYY-MM-DDTHH:MM" (local), feelsC }]; window in local "HH:MM".
export function summarizeWindow(hourly, date, leave, back) {
  const inWin = hourly.filter(h => h.time.slice(0, 10) === date && h.time.slice(11, 16) >= leave.slice(0, 2) + ":00" && h.time.slice(11, 16) <= back);
  if (!inWin.length) return null;
  const vals = inWin.map(h => h.feelsC);
  const pick = hh => { const m = inWin.find(h => h.time.slice(11, 13) === hh); return m ? m.feelsC : null; };
  return {
    minFeelsC: Math.min(...vals),
    maxFeelsC: Math.max(...vals),
    morningC: pick(leave.slice(0, 2)),
    middayC: pick("13"),
    eveningC: pick(back.slice(0, 2)),
  };
}

function daysSince(dateA, dateB) {
  return Math.round((Date.parse(dateB + "T00:00:00Z") - Date.parse(dateA + "T00:00:00Z")) / DAY_MS);
}

function lastWornMap(wears) {
  const m = {};
  for (const w of wears) for (const id of w.itemIds) if (!m[id] || w.date > m[id]) m[id] = w.date;
  return m;
}

function slotOf(item, cfg) { return cfg.categories[item.category]?.slot; }
function warmthOf(item, cfg) { return item.warmth ?? cfg.categories[item.category]?.warmth ?? 0; }

function recencyPenalty(item, lastWorn, today, cfg) {
  const d = lastWorn[item.id];
  if (!d) return 0;
  const n = daysSince(d, today);
  return n < cfg.recentlyWornDays ? cfg.recentlyWornPenalty * (cfg.recentlyWornDays - n) : 0;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// input: { items, window: {minFeelsC, maxFeelsC}, offsetC, today: "YYYY-MM-DD", wears: [{date, itemIds}],
//          exclude?: [itemId], fixed?: { slot: itemId|null } }
export function recommend(input, cfg) {
  const { window, offsetC = 0, today, wears = [], exclude = [], fixed = {} } = input;
  const items = input.items.filter(i => !i.deletedAt && i.status !== "laundry" && !exclude.includes(i.id)).sort(byId);
  const lastWorn = lastWornMap(wears);
  const pool = s => items.filter(i => slotOf(i, cfg) === s);
  const effC = Math.round((window.minFeelsC + offsetC) * 10) / 10;
  const need = requiredWarmth(effC, cfg);

  const bases = pool("base"), mids = pool("mid"), outers = pool("outer"), bottoms = pool("bottom"), shoes = pool("shoes");
  const missing = [];
  if (!bases.length) missing.push("base");
  if (!bottoms.length) missing.push("bottom");
  if (!shoes.length) missing.push("shoes");
  if (missing.length) return { status: "incomplete", missing, effC, requiredWarmth: need };

  const pen = i => (i ? recencyPenalty(i, lastWorn, today, cfg) : 0);
  const choose = (list, slot, extra = () => 0) => {
    if (slot in fixed) return list.find(i => i.id === fixed[slot]) ?? null;
    return [...list].sort((a, b) => (pen(a) + extra(a)) - (pen(b) + extra(b)) || byId(a, b))[0];
  };

  // Upper body: base + optional mid + optional outer, scored on warmth fit and recency.
  const candidatesFor = (slot, list) => (slot in fixed ? [list.find(i => i.id === fixed[slot]) ?? null] : [null, ...list]);
  let best = null;
  const baseList = slot => (slot in fixed ? [bases.find(i => i.id === fixed.base)] : bases);
  for (const b of baseList("base")) for (const m of candidatesFor("mid", mids)) for (const o of candidatesFor("outer", outers)) {
    const w = warmthOf(b, cfg) + (m ? warmthOf(m, cfg) : 0) + (o ? warmthOf(o, cfg) : 0);
    const under = Math.max(0, need - w), over = Math.max(0, w - need);
    // Prefer an outer layer over a mid layer when the day warms up a lot (easy to take off).
    // A mid layer alone is harder to take off than an open outer layer: small penalty, larger on days that warm up.
    const swing = m && !o ? (window.maxFeelsC - window.minFeelsC >= 5 ? 2 : 1) : 0;
    const score = under * cfg.undershootWeight + over * cfg.overshootWeight + pen(b) + pen(m) + pen(o) + swing;
    const key = [b.id, m?.id ?? "", o?.id ?? ""].join("|");
    if (!best || score < best.score || (score === best.score && key < best.key)) best = { score, b, m, o, w, key };
  }

  const warmBottom = effC < cfg.warmBottomBelowC;
  const bottom = choose(bottoms, "bottom", i => (warmBottom && warmthOf(i, cfg) < 2 ? 10 : 0));
  const shoe = choose(shoes, "shoes", i =>
    (effC < cfg.warmBottomBelowC && i.category === "sandals" ? 10 : 0) + (effC >= 20 && warmthOf(i, cfg) >= 1 ? 10 : 0));
  const outerClosed = best.o ? effC < cfg.closeOuterBelowC : null;

  return {
    status: "ok",
    effC,
    requiredWarmth: need,
    upperWarmth: best.w,
    outfit: { base: best.b.id, mid: best.m?.id ?? null, outer: best.o?.id ?? null, bottom: bottom.id, shoes: shoe.id },
    outerClosed,
    shortfall: Math.max(0, need - best.w),
  };
}

// Ranked alternatives for one slot, keeping the other slots fixed.
export function alternatives(input, current, slot, cfg) {
  const items = input.items.filter(i => !i.deletedAt && i.status !== "laundry" && slotOf(i, cfg) === slot).sort(byId);
  const out = [];
  for (const it of items) {
    if (it.id === current[slot]) continue;
    const fixed = { ...current, [slot]: it.id };
    const r = recommend({ ...input, fixed }, cfg);
    if (r.status !== "ok") continue;
    out.push({ id: it.id, upperWarmth: r.upperWarmth, fits: r.shortfall === 0 });
  }
  return out.sort((a, b) => (b.fits - a.fits) || byId(a, b));
}

// Starter-set progress for onboarding.
export function starterProgress(items, cfg) {
  const live = items.filter(i => !i.deletedAt);
  const count = s => live.filter(i => slotOf(i, cfg) === s).length;
  const req = cfg.starterSet;
  const upper = count("base");
  return {
    total: live.length, goal: req.total,
    base: [Math.min(upper, req.base), req.base],
    bottom: [Math.min(count("bottom"), req.bottom), req.bottom],
    shoes: [Math.min(count("shoes"), req.shoes), req.shoes],
    outer: [Math.min(count("outer") + count("mid"), req.outer), req.outer],
    ready: upper >= 1 && count("bottom") >= 1 && count("shoes") >= 1,
  };
}
