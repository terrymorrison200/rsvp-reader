const V='swiftread-v8';
const ASSETS=['./','index.html','styles.css','app.js','manifest.webmanifest','vendor/jszip.min.js','vendor/pdf.min.mjs','vendor/pdf.worker.min.mjs','fonts/inter-latin-400-normal.woff2','fonts/inter-latin-600-normal.woff2','fonts/literata-latin-400-normal.woff2','fonts/jetbrains-mono-latin-400-normal.woff2','fonts/opendyslexic-latin-400-normal.woff2','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;
  const put=r=>{if(r.ok){const cp=r.clone();caches.open(V).then(c=>c.put(e.request,cp));}return r;};
  // app shell (html/js/css): network-first so updates arrive on next open; everything else cache-first
  if(e.request.mode==='navigate'||/\.(html|js|css|webmanifest|json)$|\/$/.test(u.pathname)){e.respondWith(fetch(e.request).then(put).catch(()=>caches.match(e.request,{ignoreSearch:true})));return;}
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(hit=>hit||fetch(e.request).then(put)));});
