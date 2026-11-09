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

// Background removal adapter. Web: ORMBG (Apache-2.0, int8 ≈ 44 MB) in a background worker, downloaded on first use
// and cached. iOS: Vision foreground mask. Android: ML Kit subject segmentation.
import { runModel } from "./ml.js";
export async function removeBackground(blob, onProgress) {
  const { width, height, rgba } = await runModel("bg", blob, (f, info) => onProgress?.(info ? "engine" : "download", f, info));
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer || rgba), width, height), 0, 0);
  return new Promise(r => c.toBlob(r, "image/png"));
}
