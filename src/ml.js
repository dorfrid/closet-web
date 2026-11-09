// Main-thread client for src/ml-worker.js.
let worker, seq = 0;
const waiting = {};
function w() {
  if (worker) return worker;
  worker = new Worker(new URL("./ml-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const job = waiting[data.id];
    if (!job) return;
    if (data.progress != null) { job.onProgress?.(data.progress); return; }
    if (data.info) { job.onProgress?.(null, data.info); return; }
    delete waiting[data.id];
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
  };
  worker.onerror = e => { for (const k of Object.keys(waiting)) { waiting[k].reject(new Error(e.message || "Model worker failed")); delete waiting[k]; } worker = null; };
  return worker;
}
export function runModel(kind, input, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting[id] = { resolve, reject, onProgress };
    w().postMessage({ id, kind, input });
  });
}
