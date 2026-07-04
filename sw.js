// YouTube Finder PWA Service Worker
const CACHE_NAME = 'yt-finder-v113';
const CORE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// ?ㅼ튂 ???듭떖 ?뚯씪 罹먯떆
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('[SW] install cache failed:', err))
    );
});

// ?쒖꽦?????댁쟾 罹먯떆 ?뺣━
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// ?붿껌 泥섎━ ??Network First + Cache Fallback
// ?몃? API ?몄텧(news.json, gemini, kie ??? 罹먯떆 ????self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // GET ?붿껌留?泥섎━
    if (event.request.method !== 'GET') return;

    // API ?몄텧? ?⑥뒪 (Gemini, Kie, etc)
    if (url.origin !== self.location.origin) return;

    // ?숈쟻 ?곗씠??news.json, channels.json) ??긽 fresh ??湲곌린 媛??숆린???꾪빐 罹먯떆 湲덉?
    if (url.pathname.endsWith('/news.json') || url.pathname.endsWith('/channels.json')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // ?뺤쟻 ?먯썝 ??Network First, ?ㅽ뙣 ??Cache
    event.respondWith(
        fetch(event.request)
            .then((res) => {
                if (res && res.ok && res.type === 'basic') {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(event.request))
    );
});
