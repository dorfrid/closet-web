// Runs the on-device models off the main thread, so the page never freezes ("Page Unresponsive").
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
let tfP;
const tf = () => (tfP ||= import(TF_URL));
const pipes = {}, devices = {};
const SPECS = {
  seg: { task: "image-segmentation", model: "Xenova/segformer_b2_clothes", wasm: "q8", gpu: "fp16" },
  bg: { task: "background-removal", model: "onnx-community/ormbg-ONNX", wasm: "int8", gpu: "fp16" },
};
let gpuOk = null;
async function hasGPU() {
  if (gpuOk != null) return gpuOk;
  // Needs half-precision support (shader-f16), otherwise the fp16 models cannot run on the GPU.
  try { const ad = self.navigator?.gpu && (await navigator.gpu.requestAdapter()); gpuOk = !!ad && ad.features.has("shader-f16"); } catch { gpuOk = false; }
  return gpuOk;
}
// WebGPU (graphics chip) is many times faster than WASM (CPU, one thread on a static site). Fall back if it fails.
function getPipe(kind, id) {
  const s = SPECS[kind];
  const progress_callback = p => { if (p.status === "progress" && p.total) postMessage({ id, progress: p.loaded / p.total }); };
  pipes[kind] ||= (async () => {
    const t = await tf();
    if (await hasGPU()) {
      try { const p = await t.pipeline(s.task, s.model, { dtype: s.gpu, device: "webgpu", progress_callback }); devices[kind] = "webgpu"; return p; }
      catch (e) { console.warn("WebGPU failed, using WASM", e); }
    }
    devices[kind] = "wasm";
    return t.pipeline(s.task, s.model, { dtype: s.wasm, device: "wasm", progress_callback });
  })();
  pipes[kind].catch(() => { delete pipes[kind]; });
  return pipes[kind];
}

onmessage = async ({ data: { id, kind, input } }) => {
  try {
    const pipe = await getPipe(kind, id);
    if (!input) { postMessage({ id, result: true }); return; } // warm-up only
    postMessage({ id, info: devices[kind] }); // tells the page which engine is computing now
    const url = URL.createObjectURL(input);
    try {
      if (kind === "seg") {
        const out = await pipe(url);
        const res = out.map(o => ({ label: o.label, width: o.mask.width, height: o.mask.height, channels: o.mask.channels, data: o.mask.data }));
        postMessage({ id, result: res }, res.map(r => r.data.buffer));
      } else {
        const o = await pipe(url);
        const img = Array.isArray(o) ? o[0] : o;
        const rgba = img.rgba().data;
        postMessage({ id, result: { width: img.width, height: img.height, rgba } }, [rgba.buffer]);
      }
    } finally { URL.revokeObjectURL(url); }
  } catch (e) { postMessage({ id, error: String(e?.message || e) }); }
};
