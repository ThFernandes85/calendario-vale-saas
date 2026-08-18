// Service Worker -- cacheia só o "shell" do app (o próprio HTML, o
// manifest e os ícones de docs/assets) pra ele conseguir ABRIR mesmo sem
// sinal nenhum (uso de campo do Encarregado). Tudo o resto -- toda chamada
// pro Supabase (auth/API/Storage), qualquer requisição de outro método
// (POST/PUT/...), qualquer origem diferente da do próprio site -- nunca é
// interceptado: cai fora do "if (!isShell) return" e o navegador cuida
// sozinho, exatamente como se este arquivo nem existisse.
//
// Isso é deliberadamente conservador: uma versão anterior tentava
// cachear/re-interceptar de forma mais ampla e isso quebrava navegação de
// verdade ("Failed to fetch"), inclusive em requisições cross-origin que
// não deveriam ter sido tocadas. Os dois primeiros checks abaixo (método e
// origem) são o que evita repetir esse tipo de bug -- eles vêm antes de
// qualquer lista de caminhos, sem exceção.
const SHELL_CACHE = 'terravia-shell-v1';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(names.filter(n => n !== SHELL_CACHE).map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

// Responde do cache na hora se já existir uma cópia (funciona offline), e
// SEMPRE busca uma versão nova em paralelo pra atualizar o cache pro
// próximo carregamento -- sem precisar de nenhum número de versão pra
// lembrar de "bumpar" a cada deploy: o cache se autoatualiza sozinho todo
// carregamento online bem-sucedido.
async function staleWhileRevalidate(request) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then(res => {
        if (res && res.ok) cache.put(request, res.clone());
        return res;
    }).catch(() => null);
    if (cached) {
        network.catch(() => {}); // atualização em segundo plano, sem travar a resposta
        return cached;
    }
    const fresh = await network;
    return fresh || Response.error();
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    const isShell = url.pathname === '/' || url.pathname.endsWith('/index.html')
        || url.pathname.endsWith('/manifest.json') || url.pathname.includes('/assets/');
    if (!isShell) return;
    event.respondWith(staleWhileRevalidate(req));
});
