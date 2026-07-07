// アプリ起動時にService Worker(`public/sw.js` → ビルド後 `<base>/sw.js`)を
// 登録する。参照: tasks/T014-pwa-setup.md

/**
 * Service Workerを登録する。
 * - `navigator.serviceWorker` が使えない環境(非対応ブラウザ)ではフィーチャー
 *   検出により何もせず、エラーにもならない。
 * - `npm run dev` の開発サーバーでは登録しない。SWのcache-first戦略は
 *   HMR(ホットリロード)によるファイル更新と相性が悪く、開発中に古い
 *   キャッシュが返り続けて混乱する原因になるため、`import.meta.env.PROD`
 *   (`npm run build` の成果物であることを示す)が真の場合のみ登録する。
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  if (!import.meta.env.PROD) {
    return;
  }

  window.addEventListener('load', () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(swUrl).catch((error: unknown) => {
      console.error('[registerServiceWorker] registration failed:', error);
    });
  });
}
