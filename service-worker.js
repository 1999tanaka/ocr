const CACHE='seven-seg-v8';
const CORE=['./','./index.html','./style.css','./app-v4.js','./manifest.json'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.origin===location.origin&&(u.pathname.endsWith('.js')||u.pathname.endsWith('.css')||u.pathname.endsWith('.html')||u.pathname.endsWith('/ocr/'))){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)))}else{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))}
});
