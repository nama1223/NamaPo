// NamaTempoTrainer Service Worker
//
// 更新ポリシー:
//   - CACHE_NAME は「キャッシュを完全リセットしたい時だけ」バージョンを上げる。
//   - SW 自体（このファイル）を変更すれば、ブラウザが自動的に再登録する。
//
// 必須リソース（index.html等）の取得に失敗したら install 自体を失敗させ、
// ブラウザに古いSW（＝古いキャッシュ）をそのまま維持させる方針。
// 中途半端な新キャッシュへの切り替えでオフライン起動が壊れるのを防ぐため。
// （NamaCollage の sw.js v4 と同じ設計思想を踏襲）

const CACHE_NAME = 'namatempotrainer-v1';

// 無いとアプリが起動できない必須リソース。1つでも取得失敗したら install 自体を失敗させる。
const CRITICAL = [
  './',
  './index.html',
];
// あれば嬉しい程度のリソース（アイコン・マニフェスト）。
// 失敗しても install は続行する（allSettled）。
const OPTIONAL = [
  './manifest.json',
  './NamaPo192.png',
  './NamaPo512.png',
];

// ============================================================
// Install: プリキャッシュ（HTTPキャッシュを無視して強制取得）
// ============================================================
let _isUpdate = false;

self.addEventListener('install', event => {
  _isUpdate = !!self.registration.active;
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        // 1. 必須リソース: 1つでも失敗したら例外を投げて install 自体を失敗させる
        //    （失敗時はブラウザが古いSW/古いキャッシュをそのまま維持し、次回リトライする）
        for (const url of CRITICAL) {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req); // 失敗すればここで例外→install失敗
          if (!res.ok) throw new Error(`SW: precache failed (${res.status}) for ${url}`);
          await cache.put(url, res.clone());
        }
        // 2. 任意リソース（アイコン・マニフェスト等）: ベストエフォート
        //    cache: 'reload' を指定して強制的にネットワークから最新を取得する
        await Promise.allSettled(OPTIONAL.map(async url => {
          try {
            const req = new Request(url, { cache: 'reload' });
            const res = await fetch(req);
            if (res.ok) await cache.put(url, res);
          } catch (e) {
            console.warn(`SW: Failed to precache ${url}`, e);
          }
        }));
      })
      .then(() => self.skipWaiting())
  );
});

// ============================================================
// Activate: 古いキャッシュを削除
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        if (_isUpdate) {
          const clients = await self.clients.matchAll({ type: 'window' });
          for (const client of clients) {
            client.postMessage({ type: 'sw_updated' });
          }
        }
      })
  );
});

// ============================================================
// Fetch: 戦略の使い分け（HTMLはNetwork-First, 他はSWR）
// ============================================================
self.addEventListener('fetch', event => {
  // GET のみ対象
  if (event.request.method !== 'GET') return;

  // 同一オリジン以外はブラウザの通常挙動に任せる
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // 1. HTMLリクエスト（画面遷移）は Network-First
  // 常に最新版を見に行き、オフライン時のみキャッシュから返す
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return response;
        })
        .catch(async () => {
          // オフライン時はキャッシュから返す。
          // './index.html' と './' のどちらにも念のためフォールバックを試みる。
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html', { ignoreSearch: true }))
              || (await cache.match('./', { ignoreSearch: true }))
              || Response.error();
        })
    );
    return;
  }

  // 2. それ以外（アイコン画像など）は Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const revalidate = fetch(event.request)
          .then(response => {
            if (response && response.ok && response.type === 'basic') {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch(() => null);

        return cached || revalidate;
      })
    )
  );
});
