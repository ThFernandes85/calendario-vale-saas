// Service Worker mínimo -- existe só pra o Chrome/Android considerar o
// site "instalável como app" (com manifest + service worker, oferece
// "Instalar app" de verdade; sem service worker, só oferece "Criar
// atalho", que é o problema que estávamos vendo). Não guarda nada em
// cache de propósito -- o app sempre busca a versão mais nova na rede,
// pra não repetir o problema de conteúdo antigo grudado no celular.
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});
