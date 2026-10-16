// Service Worker do módulo Armazém (escopo /armazem/, separado do sw.js do app
// principal de propósito: os dois não podem misturar regras de cache).
//
// Estratégia: REDE PRIMEIRO, cache de reserva. Com sinal, o app sempre carrega
// a versão mais nova (não tem o problema de "só atualiza no 2º reload" do app
// principal). Sem sinal, abre a última versão guardada — o suficiente pro
// operador abrir o app dentro do galpão. Só mexe em GET da própria origem;
// Supabase, bibliotecas de CDN e qualquer outra origem passam direto.
const CACHE = 'terravia-armazem-v1';
const SHELL = ['index.html', 'gestao.html', 'campo.html', 'comum.css', 'comum.js', 'gestao.js', 'campo.js', 'manifest.json'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE)
            .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => { /* arquivo ainda não existe: ignora */ }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(names.filter(n => n !== CACHE && n !== 'tv-arm-fotos').map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.includes('/armazem/') && !url.pathname.includes('/assets/')) return;

    event.respondWith(
        fetch(req)
            .then(res => {
                if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
});
