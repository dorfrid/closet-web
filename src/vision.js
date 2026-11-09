// On-device vision for bulk import. Nothing here sends images anywhere.
// - Clothes parsing: SegFormer B2 (clothes), via Transformers.js. ~29 MB first download (q8), cached by the browser.
// - Faces: hidden using the same parser (face/hair labels + everything above the shirt). No second model.
import { runModel } from "./ml.js";

export function loadSegmenter(onProgress) { return runModel("seg", null, onProgress); }

export async function blobToCanvas(blob, maxSide = 768) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

const GROUPS = {
  upper: ["Upper-clothes", "Dress", "Scarf"],
  lower: ["Pants", "Skirt"],
  shoes: ["Left-shoe", "Right-shoe"],
  face: ["Face", "Hair", "Sunglasses", "Hat"],
};

// Returns { width, height, masks: { upper, lower, shoes, face } } where each mask is Uint8Array (0/1) or null.
export async function parseClothes(canvas) {
  const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.9));
  const out = await runModel("seg", blob);
  const w = canvas.width, h = canvas.height;
  const read = o => { // value at canvas pixel i, nearest-neighbour if the mask size differs
    if (o.width === w && o.height === h) return i => o.data[i * o.channels];
    return i => { const x = i % w, y = (i / w) | 0; return o.data[(((y * o.height / h) | 0) * o.width + ((x * o.width / w) | 0)) * o.channels]; };
  };
  const masks = {};
  const person = new Uint8Array(w * h);
  for (const o of out) {
    if (o.label === "Background") continue;
    const r = read(o);
    for (let i = 0; i < person.length; i++) if (r(i) > 127) person[i] = 1;
  }
  masks.person = person;
  for (const [g, labels] of Object.entries(GROUPS)) {
    let m = null;
    for (const o of out) {
      if (!labels.includes(o.label)) continue;
      const r = read(o);
      m ||= new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) if (r(i) > 127) m[i] = 1;
    }
    masks[g] = m;
  }
  return { width: w, height: h, masks };
}

function bbox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return n ? { x0, y0, x1, y1, area: n / (w * h) } : null;
}

function pixelate(ctx, x, y, w, h) {
  const c = ctx.canvas;
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(c.width - x, Math.ceil(w)); h = Math.min(c.height - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return;
  const s = Math.max(1, Math.round(Math.max(w, h) / 7));
  const t = document.createElement("canvas"); t.width = Math.max(1, Math.round(w / s)); t.height = Math.max(1, Math.round(h / s));
  const tc = t.getContext("2d"); tc.drawImage(c, x, y, w, h, 0, 0, t.width, t.height);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(t, 0, 0, t.width, t.height, x, y, w, h); ctx.imageSmoothingEnabled = true;
}

// Hides faces in place, without a second model (memory): the parser's face/hair region, plus the whole band
// above the top of the upper garment (where a head is). Returns the number of regions hidden, or -1 if no person
// was found (then the photo must not be sent).
export async function hideFaces(canvas, parsed) {
  const ctx = canvas.getContext("2d");
  const W = parsed.width, H = parsed.height, regions = [];
  const up = parsed.masks.upper && bbox(parsed.masks.upper, W, H);
  const lo = parsed.masks.lower && bbox(parsed.masks.lower, W, H);
  // Face/hair box from the largest face part only; stray "hair/hat" pixels elsewhere must not blow it up.
  let fb = parsed.masks.face && bbox(cleanMask(parsed.masks.face, W, H, 0.3), W, H);
  if (fb && up && fb.y1 > up.y0 + (up.y1 - up.y0) * 0.35) fb = null; // implausible: reaches deep into the torso
  if (fb) { const bw = fb.x1 - fb.x0, bh = fb.y1 - fb.y0; regions.push({ x: fb.x0 - bw * 0.25, y: fb.y0 - bh * 0.25, w: bw * 1.5, h: bh * 1.5 }); }
  if (up) regions.push({ x: 0, y: 0, w: W, h: up.y0 });
  else if (!fb && !lo) return -1;
  for (const r of regions) pixelate(ctx, r.x, r.y, r.w, r.h);
  parsed.hidden = regions;
  return regions.length;
}

function components(src, w, h) {
  const lab = new Int32Array(w * h), sizes = [0], q = new Int32Array(w * h);
  for (let i = 0; i < src.length; i++) {
    if (!src[i] || lab[i]) continue;
    const id = sizes.length; let head = 0, tail = 0, n = 0;
    q[tail++] = i; lab[i] = id;
    while (head < tail) {
      const p = q[head++]; n++;
      const x = p % w, y = (p / w) | 0;
      for (const np of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (np >= 0 && src[np] && !lab[np]) { lab[np] = id; q[tail++] = np; }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}

// Finds the separate people in a photo. A person whose area contains 2+ faces is really several people
// touching each other (cannot be separated safely) → merged = true.
export function analyzePeople(parsed) {
  const W = parsed.width, H = parsed.height, pm = parsed.masks.person;
  if (!pm) return { candidates: [], merged: false };
  const { lab, sizes } = components(pm, W, H);
  const max = Math.max(0, ...sizes.slice(1));
  const ids = [];
  for (let i = 1; i < sizes.length; i++) if (sizes[i] >= max * 0.2 && sizes[i] >= W * H * 0.02) ids.push(i);
  const boxes = {};
  for (let p = 0; p < lab.length; p++) {
    const id = lab[p]; if (!ids.includes(id)) continue;
    const x = p % W, y = (p / W) | 0, b = (boxes[id] ||= { x0: x, y0: y, x1: x, y1: y });
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  const faces = {};
  if (parsed.masks.face) {
    const fc = components(parsed.masks.face, W, H);
    for (let f = 1; f < fc.sizes.length; f++) {
      if (fc.sizes[f] < W * H * 0.0005) continue;
      const at = fc.lab.indexOf(f), owner = lab[at];
      if (owner) faces[owner] = (faces[owner] || 0) + 1;
    }
  }
  const candidates = ids.map(id => ({ id, area: sizes[id] / (W * H), faces: faces[id] || 0, box: boxes[id] }))
    .sort((a, b) => b.area - a.area);
  return { candidates, merged: candidates.some(c => c.faces >= 2), lab };
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
}
export function candidateNear(analysis, box) {
  let best = null, score = 0;
  for (const c of analysis.candidates) { const v = iou(c.box, box); if (v > score) { score = v; best = c; } }
  return score > 0.5 ? best : null;
}

// Keeps one person: everyone else and everything outside that person's area is greyed out
// (also protects other people's privacy), and all masks are restricted to that person.
export function isolatePerson(canvas, parsed, analysis, cand) {
  const W = parsed.width, H = parsed.height, lab = analysis.lab, main = cand.id;
  let { x0, y0, x1, y1 } = cand.box;
  const mx = (x1 - x0) * 0.08, my = (y1 - y0) * 0.05;
  x0 = Math.max(0, x0 - mx); x1 = Math.min(W - 1, x1 + mx); y0 = Math.max(0, y0 - my); y1 = Math.min(H - 1, y1 + my);
  const ctx = canvas.getContext("2d"), img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if ((lab[i] && lab[i] !== main) || x < x0 || x > x1 || y < y0 || y > y1) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 128;
  }
  ctx.putImageData(img, 0, 0);
  for (const k of Object.keys(parsed.masks)) {
    const m = parsed.masks[k];
    if (m) for (let i = 0; i < m.length; i++) if (lab[i] !== main) m[i] = 0;
  }
}

// Keeps connected parts that are at least 15% of the largest part (drops stray pixels; keeps both shoes).
function cleanMask(src, w, h, minShare = 0.15) {
  const lab = new Int32Array(w * h), sizes = [0];
  const q = new Int32Array(w * h);
  for (let i = 0; i < src.length; i++) {
    if (!src[i] || lab[i]) continue;
    const id = sizes.length; let head = 0, tail = 0, n = 0;
    q[tail++] = i; lab[i] = id;
    while (head < tail) {
      const p = q[head++]; n++;
      const x = p % w, y = (p / w) | 0;
      for (const np of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (np >= 0 && src[np] && !lab[np]) { lab[np] = id; q[tail++] = np; }
    }
    sizes.push(n);
  }
  const max = Math.max(0, ...sizes);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (lab[i] && sizes[lab[i]] >= max * minShare) out[i] = 1;
  return out;
}

// Cuts one region out with transparent background. Returns { blob, area } or null if the region is too small.
// Face and hair pixels are always removed from the cut-out.
export async function cutRegion(canvas, parsed, group) {
  let m = parsed.masks[group];
  if (!m) return null;
  const W = parsed.width, H = parsed.height;
  m = m.slice();
  if (parsed.masks.face) { const f = parsed.masks.face; for (let i = 0; i < m.length; i++) if (f[i]) m[i] = 0; }
  for (const r of parsed.hidden || []) // never include a hidden (pixelated) face area in a cut-out
    for (let y = Math.max(0, r.y | 0); y < Math.min(H, r.y + r.h); y++) for (let x = Math.max(0, r.x | 0); x < Math.min(W, r.x + r.w); x++) m[y * W + x] = 0;
  if (group === "shoes" && parsed.masks.lower) { // shoes sit below the middle of the trousers; drops held objects
    const lb = bbox(parsed.masks.lower, W, H);
    if (lb) { const cut = Math.round((lb.y0 + lb.y1) / 2); m.fill(0, 0, cut * W); }
  }
  m = cleanMask(m, parsed.width, parsed.height);
  const b = bbox(m, parsed.width, parsed.height);
  if (!b || b.area < (group === "shoes" ? 0.002 : 0.01)) return null;
  const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04);
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad), x1 = Math.min(parsed.width - 1, b.x1 + pad), y1 = Math.min(parsed.height - 1, b.y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const src = canvas.getContext("2d").getImageData(x0, y0, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!m[(y + y0) * parsed.width + (x + x0)]) src.data[(y * w + x) * 4 + 3] = 0;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").putImageData(src, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  return { blob, area: b.area };
}
