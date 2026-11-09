// On-device vision for bulk import. Nothing here sends images anywhere.
// - Clothes parsing: SegFormer B2 (clothes), via Transformers.js. ~100 MB first download, cached by the browser.
// - Face detection: MediaPipe BlazeFace (~0.3 MB), used together with the parser's Face/Hair labels.
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let segP, faceP;
export function loadSegmenter(onProgress) {
  segP ||= (async () => {
    const tf = await import(TF_URL);
    return tf.pipeline("image-segmentation", "Xenova/segformer_b2_clothes", {
      progress_callback: p => { if (p.status === "progress" && p.total) onProgress?.(p.loaded / p.total); },
    });
  })();
  return segP;
}
function loadFaces() {
  faceP ||= (async () => {
    const mp = await import(MP_URL);
    const files = await mp.FilesetResolver.forVisionTasks(MP_URL + "/wasm");
    return mp.FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "IMAGE", minDetectionConfidence: 0.3 });
  })();
  return faceP;
}

export async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
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
  const seg = await loadSegmenter();
  const out = await seg(canvas.toDataURL("image/jpeg", 0.9));
  const w = canvas.width, h = canvas.height;
  const masks = {};
  for (const [g, labels] of Object.entries(GROUPS)) {
    let m = null;
    for (const o of out) {
      if (!labels.includes(o.label)) continue;
      const mk = o.mask.width === w && o.mask.height === h ? o.mask : await o.mask.resize(w, h);
      m ||= new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) if (mk.data[i * mk.channels] > 127) m[i] = 1;
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

// Hides faces in place. Union of MediaPipe boxes and the parser's face/hair region, both expanded.
// Returns the number of regions hidden.
export async function hideFaces(canvas, parsed) {
  const ctx = canvas.getContext("2d");
  const regions = [];
  try {
    const det = await loadFaces();
    for (const d of det.detect(canvas).detections) {
      const b = d.boundingBox;
      regions.push({ x: b.originX - b.width * 0.4, y: b.originY - b.height * 0.6, w: b.width * 1.8, h: b.height * 1.9 });
    }
  } catch (e) { console.warn("face detector unavailable", e); }
  if (parsed?.masks.face) {
    const b = bbox(parsed.masks.face, parsed.width, parsed.height);
    if (b) { const bw = b.x1 - b.x0, bh = b.y1 - b.y0; regions.push({ x: b.x0 - bw * 0.2, y: b.y0 - bh * 0.2, w: bw * 1.4, h: bh * 1.4 }); }
  }
  for (const r of regions) pixelate(ctx, r.x, r.y, r.w, r.h);
  if (parsed) parsed.hidden = regions;
  return regions.length;
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
