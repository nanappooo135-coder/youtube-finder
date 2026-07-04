// YouTube Finder PWA Service Worker
const CACHE_NAME = 'yt-finder-v99';
const CORE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// 설치 — 핵심 파일 캐시
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('[SW] install cache failed:', err))
    );
});

// 활성화 — 이전 캐시 정리
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// 요청 처리 — Network First + Cache Fallback
// 외부 API 호출(news.json, gemini, kie 등)은 캐시 안 함
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // GET 요청만 처리
    if (event.request.method !== 'GET') return;

    // API 호출은 패스 (Gemini, Kie, etc)
    if (url.origin !== self.location.origin) return;

    // 동적 데이터(news.json, channels.json) 항상 fresh — 기기 간 동기화 위해 캐시 금지
    if (url.pathname.endsWith('/news.json') || url.pathname.endsWith('/channels.json')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // 정적 자원 — Network First, 실패 시 Cache
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
