// オセロトレーナーのService Worker(素のJS、Workbox不使用)。
// `app/public/` に置くことでVite/GitHub Pagesの `base`(例: `/othello-trainer/`)
// 配下にそのままコピーされ、`<base>/sw.js` として配信される。
//
// 方針(参照: tasks/T014-pwa-setup.md):
// - install時にアプリシェル(index.html / manifest / アイコン / index.htmlが
//   参照するハッシュ付きJS・CSSファイル)をプリキャッシュする。
//   ビルドで生成されるJS/CSS/WASMのファイル名はハッシュ付きで毎回変わるため、
//   ビルド成果物を静的に列挙する代わりに、install時に実際の `index.html` を
//   fetchして中の `<script src>` / `<link href>` を読み取り、動的に発見する。
// - fetch時の戦略はリクエストの種類で分ける(T062: sw-update-propagation-fix)。
//   - ページ本体(index.html、ナビゲーションリクエスト)はネットワーク優先
//     (オフライン時のみキャッシュへフォールバック)。新しいデプロイの内容が
//     速やかに反映されるようにするため。
//   - それ以外(ハッシュ付きJS/CSS/WASM等の静的アセット)はcache-first
//     (キャッシュにあればキャッシュを返し、無ければネットワークから取得して
//     キャッシュに追加してから返す)。ビルドごとにファイル名が変わるため、
//     内容が変わらない限りキャッシュのままで問題ない。これにより
//     WASMファイル(`engine_bg-*.wasm`)やWorkerのJS(`worker-*.js`)も、
//     初回アクセス時にネットワークから取得された時点でキャッシュされる。
// - キャッシュ名にバージョン文字列を含め、新しいService Workerが
//   activateされたら、現在のバージョン以外のキャッシュを削除する。
//   (ユーザー向けの更新通知バナーは`app/src/registerServiceWorker.ts`側で
//   処理する。参照: tasks/T062-sw-update-propagation-fix.md)

// `__BUILD_VERSION__` はビルド成果物(`dist/sw.js`)に対して、ビルド後処理
// スクリプト `scripts/inject-sw-version.mjs`(`npm run build` の一部として自動実行)
// が実際のビルドごとに一意な値(gitコミットハッシュ+ビルド時刻)へ置換する
// プレースホルダー。手動更新は不要(参照: tasks/T023-sw-cache-versioning-fix.md)。
// `app/public/sw.js` 自体(このファイル)は `npm run dev` では使われず、
// `vite preview` 等で直接このプレースホルダーのまま読み込まれても
// (置換前でも)キャッシュ名として機能上問題は無い。
const CACHE_VERSION = '__BUILD_VERSION__';
const CACHE_NAME = `othello-trainer-v${CACHE_VERSION}`;

// アプリシェルのうち、ファイル名が固定(ハッシュなし)なもの。
// `sw.js` 自身から見て相対パス(= `<base>/` 配下)で解決される。
const FIXED_SHELL_URLS = [
  './',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

/**
 * `index.html` を取得し、そこから参照されているハッシュ付きJS/CSSアセットの
 * URLを抽出する。取得やパースに失敗した場合は空配列を返す(致命的にしない)。
 */
async function discoverHashedAssetUrls() {
  try {
    const response = await fetch('./', { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }
    const html = await response.text();
    const urls = new Set();
    const attrPattern = /\s(?:src|href)="([^"]+)"/g;
    let match;
    while ((match = attrPattern.exec(html)) !== null) {
      const url = match[1];
      // 同一オリジンの静的アセット(assets/配下、または拡張子でJS/CSSと
      // 分かるもの)のみを対象にする。外部URLやdata:等は除外する。
      if (/\.(?:js|css)(?:\?.*)?$/.test(url) && !/^https?:\/\//.test(url)) {
        urls.add(url);
      }
    }
    return Array.from(urls);
  } catch (error) {
    console.error('[sw] failed to discover hashed asset urls:', error);
    return [];
  }
}

/** アプリシェルをキャッシュに追加する。1件ずつ試み、失敗しても全体は失敗させない。 */
async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const hashedUrls = await discoverHashedAssetUrls();
  const targets = [...FIXED_SHELL_URLS, ...hashedUrls];
  await Promise.all(
    targets.map(async (url) => {
      try {
        await cache.add(url);
      } catch (error) {
        console.error('[sw] failed to precache:', url, error);
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  // 新しいService Workerを即座にwaiting状態から抜けさせる。
  // (`registerServiceWorker.ts`が更新検知・通知バナー表示を行うため、
  // SW自体は速やかに有効化・クライアントの制御を奪う方針のまま。)
  self.skipWaiting();
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // GET以外(POST等)やcross-originリクエストはキャッシュ対象外(素通し)。
  if (request.method !== 'GET') {
    return;
  }
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // ページ本体(index.html、ナビゲーションリクエスト)はネットワーク優先で
  // 処理する(T062: sw-update-propagation-fix)。以前はここもcache-firstで
  // 扱っていたため、一度アプリシェルがキャッシュされると、新しいデプロイが
  // あってもユーザーが手動でキャッシュをクリアしない限り古いindex.htmlが
  // 返り続けていた。ハッシュ付きの静的アセット(JS/CSS/WASM)はビルドごとに
  // ファイル名が変わり内容が変わらない限りキャッシュのままで問題ないため、
  // 引き続きcache-first(下の`handleCacheFirst`)で扱う。
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  event.respondWith(handleCacheFirst(request));
});

/**
 * ページ本体(ナビゲーションリクエスト)用: ネットワーク優先戦略。
 * ネットワーク取得に成功したらレスポンスをキャッシュにも保存し(次回オフライン
 * 時のフォールバック用)、そのまま返す。取得に失敗した場合(オフライン等)や
 * 取得はできたがエラーレスポンス(4xx/5xx、CDN側の一時的な不具合等)だった
 * 場合は、このリクエスト自体のキャッシュ、それも無ければアプリシェル(`./`)の
 * キャッシュにフォールバックする(オフライン動作の維持、およびCDNの一時的な
 * 不調による新規リグレッションの回避)。
 *
 * `{ cache: 'no-store' }` が重要: これが無いと、配信サーバーが`index.html`に
 * `Cache-Control: max-age=...`(GitHub Pages/Fastlyは実際に`max-age=600`を
 * 付与している)を付けている場合、Service WorkerのCache Storageは正しく
 * バイパスできていても、ブラウザ自身のHTTPキャッシュ層(Cache Storageとは別物)
 * によって`fetch(request)`が実際のネットワークへ問い合わせず古いレスポンスを
 * 返してしまい、「ネットワーク優先」が実質的に骨抜きになる(最大10分古い
 * ままになりうる、reviewer検証で発見)。`discoverHashedAssetUrls`の
 * `fetch('./', { cache: 'no-store' })`と同じ対策をここでも行う。
 */
async function handleNavigate(request) {
  try {
    const networkResponse = await fetch(request, { cache: 'no-store' });
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      // レスポンスボディはstream一度しか読めないため、キャッシュ用に
      // clone()してから保存する。
      void cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    // ネットワークには到達できたがエラーレスポンス(4xx/5xx)だった場合。
    // CDN側の一時的な不調でユーザー体験を壊さないよう、使えるキャッシュが
    // あればそちらにフォールバックする(無ければエラーレスポンスをそのまま返す)。
    const cachedOnError = await caches.match(request, { ignoreVary: true });
    if (cachedOnError) {
      return cachedOnError;
    }
    return networkResponse;
  } catch (error) {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) {
      return cached;
    }
    const shell = await caches.match('./', { ignoreVary: true });
    if (shell) {
      return shell;
    }
    throw error;
  }
}

/**
 * ハッシュ付き静的アセット(JS/CSS/WASM)等、ページ本体以外のリクエスト用:
 * これまで通りのcache-first戦略(キャッシュにあればキャッシュを返し、無ければ
 * ネットワークから取得してキャッシュに追加してから返す)。
 */
async function handleCacheFirst(request) {
  // `{ ignoreVary: true }` が重要: `<script crossorigin>` /
  // `<link crossorigin>` で読み込むJS/CSSはCORSモード(Originヘッダ付き)
  // でリクエストされる。配信サーバー(`vite preview`のsirv、GitHub Pages
  // 等)がレスポンスに `Vary: Origin` を付与すると、install時(SW自身の
  // 素のfetchでOriginヘッダ無し)にキャッシュしたレスポンスと、
  // 実際のページ読み込み時(Originヘッダ有り)のリクエストとで
  // Varyの値が一致せず、`ignoreVary` 無しでは常にキャッシュミスして
  // オフライン時に読み込めなくなる(検証中に実際に発生した不具合)。
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) {
    return cached;
  }
  const networkResponse = await fetch(request);
  if (networkResponse && networkResponse.ok) {
    const cache = await caches.open(CACHE_NAME);
    void cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}
