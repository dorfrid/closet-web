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

// Background removal adapter. Web: in-browser model, loaded only when first used (large download).
// iOS: Vision foreground mask. Android: ML Kit subject segmentation.
let lib;
export async function removeBackground(blob, onProgress) {
  if (!lib) lib = await import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm");
  const out = await lib.removeBackground(blob, {
    output: { format: "image/png" },
    progress: (key, cur, total) => onProgress?.(key, total ? cur / total : 0),
  });
  return out;
}
