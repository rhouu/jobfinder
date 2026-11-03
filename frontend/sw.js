/* Service worker: lets the site install as a phone app and show a friendly page when offline.
   Pages and files always come from the network first (so updates show at once); the saved copy is only
   used when there is no connection. API answers are never saved, so private data stays off the phone. */
const CACHE = "jobfinder-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icons/icon-192.png", "/favicon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && (req.mode === "navigate" || /\.(css|js|svg|png|webmanifest)$/.test(url.pathname))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match(OFFLINE) : Response.error()))
  );
});
