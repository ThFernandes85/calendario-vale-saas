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

// Só precisa existir esse listener pro Chrome/Android considerar o site
// instalável -- NUNCA chama respondWith(), pra não interceptar nem
// arriscar quebrar nenhum request de verdade. O "Failed to fetch" que
// vinha acontecendo era exatamente isso: re-fazer o fetch aqui dentro
// falhava pra alguns tipos de requisição (rede instável, certas
// requisições cross-origin) e derrubava a requisição inteira, inclusive
// a própria navegação da página -- explicando telas que pareciam travadas
// sem erro nenhum visível. Sem respondWith, o navegador cuida do fetch
// normal, como se o service worker nem existisse pra esse request.
self.addEventListener('fetch', () => {});
