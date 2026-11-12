// App shell cache. Bump VERSION on every release so phones pick up new files.
const VERSION = "closet-0.9.3";
const SHELL = ["./", "index.html", "app.css", "manifest.webmanifest", "src/app.js", "src/db.js", "src/weather.js", "src/images.js", "src/tokens.js", "src/strings.js", "src/bulk.js", "src/vision.js", "src/claude.js", "src/sync.js", "src/ml.js", "src/ml-worker.js", "shared/engine.js", "shared/config.json", "shared/tokens.json", "icons/icon-180.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // weather and model downloads go straight to the network
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
