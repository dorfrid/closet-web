// Image intake: every photo is decoded and re-encoded (drops EXIF/GPS, caps size). See spec: "Input security".
const MAX_SIDE = 1024, MAX_BYTES = 25 * 1024 * 1024;

export async function normalize(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Not an image");
  if (file.size > MAX_BYTES) throw new Error("Image is larger than 25 MB");
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

// Background removal adapter. Web: ORMBG (Apache-2.0, int8 ≈ 44 MB) via Transformers.js, downloaded on first use
// and cached. iOS: Vision foreground mask. Android: ML Kit subject segmentation.
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
let bgP;
export async function removeBackground(blob, onProgress) {
  bgP ||= (async () => {
    const tf = await import(TF_URL);
    return tf.pipeline("background-removal", "onnx-community/ormbg-ONNX", { dtype: "int8", device: "wasm",
      progress_callback: p => { if (p.status === "progress" && p.total) onProgress?.("download", p.loaded / p.total); } });
  })();
  let seg;
  try { seg = await bgP; } catch (e) { bgP = null; throw e; }
  const url = URL.createObjectURL(blob);
  try {
    const out = await seg(url);
    const img = Array.isArray(out) ? out[0] : out;
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.rgba().data), img.width, img.height), 0, 0);
    return await new Promise(r => c.toBlob(r, "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
