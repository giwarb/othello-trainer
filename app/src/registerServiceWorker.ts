// アプリ起動時にService Worker(`public/sw.js` → ビルド後 `<base>/sw.js`)を
// 登録する。参照: tasks/T014-pwa-setup.md
//
// T062(sw-update-propagation-fix): 新しいデプロイのService Workerが検出された
// 際に、ユーザーへ更新を通知するバナーを表示する仕組みを追加する。
// 対局・練習の途中で気づかないうちに強制リロードされることが無いよう、
// **自動リロードはしない**(バナーの「今すぐ更新」ボタンをユーザーが押した
// 時のみ`location.reload()`する)。リロードのトリガーが常にユーザーの
// クリックのみであり、SWのイベントを起点に自動でreloadを呼ぶコードパスが
// 存在しないため、無限リロードループは構造的に発生し得ない。
import { shouldNotifyUpdate } from './swUpdateLogic.ts'

/**
 * 開いたままのタブでも新デプロイに比較的早く気づけるよう、定期的に
 * `registration.update()` を呼ぶ間隔。ブラウザ標準の更新チェックは
 * ページナビゲーション時にしか発生しないことがあるため補完する。
 */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

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
    return
  }
  if (!import.meta.env.PROD) {
    return
  }

  window.addEventListener('load', () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`
    navigator.serviceWorker
      .register(swUrl)
      .then((registration) => {
        watchForUpdates(registration)
        schedulePeriodicUpdateChecks(registration)
      })
      .catch((error: unknown) => {
        console.error('[registerServiceWorker] registration failed:', error)
      })
  })
}

/**
 * 新しいService Workerのインストールを監視し、既存の(ページを制御中の)
 * Service Workerがある状態で新バージョンが`installed`になったら
 * (= 初回インストールではなく更新、`swUpdateLogic.ts`参照)、更新通知バナーを
 * 表示する。
 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  const hadExistingController = navigator.serviceWorker.controller !== null

  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing
    if (!newWorker) return

    newWorker.addEventListener('statechange', () => {
      if (shouldNotifyUpdate(hadExistingController, newWorker.state)) {
        showUpdateBanner()
      }
    })
  })
}

/**
 * ページが開いたままの間も新デプロイに気づけるよう、定期的に
 * `registration.update()` を呼ぶ。タブが非表示の間は無駄なチェックを避け、
 * 可視化された(タブに戻ってきた)タイミングでも即チェックする。
 */
function schedulePeriodicUpdateChecks(registration: ServiceWorkerRegistration): void {
  const check = () => {
    registration.update().catch(() => {
      // オフライン等での失敗は無視する(次の機会に再試行される)。
    })
  }
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check()
    }
  })
}

/** バナーの多重表示を防ぐためのフラグ。 */
let bannerShown = false

/**
 * 「新しいバージョンがあります」バナーを画面下部に表示する。ユーザーが
 * 「今すぐ更新」を押した時のみ`window.location.reload()`する(対局・練習の
 * 途中で勝手にリロードされて進行状況を失うことがないようにするため)。
 * Preactコンポーネントツリーの外側(`document.body`直下)に素のDOM APIで
 * 挿入することで、アプリ側の状態(対局中かどうか)に一切依存せず、
 * どの画面・モードからでも安全に表示できるようにしている。
 */
function showUpdateBanner(): void {
  if (bannerShown) return
  bannerShown = true

  const banner = document.createElement('div')
  banner.setAttribute('role', 'status')
  banner.style.cssText = [
    'position:fixed',
    'left:0',
    'right:0',
    'bottom:0',
    'z-index:9999',
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center',
    'justify-content:center',
    'gap:0.75rem',
    'padding:0.75rem 1rem',
    'background:#18181b',
    'color:#ffffff',
    'font-size:0.95rem',
    'box-shadow:0 -2px 8px rgba(0,0,0,0.2)',
  ].join(';')

  const message = document.createElement('span')
  message.textContent = '新しいバージョンがあります。'
  banner.appendChild(message)

  const reloadButton = document.createElement('button')
  reloadButton.type = 'button'
  reloadButton.textContent = '今すぐ更新'
  reloadButton.style.cssText = [
    'padding:0.4rem 1rem',
    'border-radius:9999px',
    'border:none',
    'background:#22c55e',
    'color:#0b0b0b',
    'font-weight:bold',
    'cursor:pointer',
  ].join(';')
  reloadButton.addEventListener('click', () => {
    window.location.reload()
  })
  banner.appendChild(reloadButton)

  const dismissButton = document.createElement('button')
  dismissButton.type = 'button'
  dismissButton.textContent = '後で'
  dismissButton.setAttribute('aria-label', '更新通知を閉じる(対局・練習を続ける)')
  dismissButton.style.cssText = [
    'padding:0.4rem 1rem',
    'border-radius:9999px',
    'border:1px solid #52525b',
    'background:transparent',
    'color:#ffffff',
    'cursor:pointer',
  ].join(';')
  dismissButton.addEventListener('click', () => {
    banner.remove()
    // 「後で」で消した場合も、将来の(この先の)別の更新検知では再度
    // 通知できるようにフラグを戻す。今回と同一の更新イベントは
    // `installed`への遷移が一度きりのため再表示されることはない。
    bannerShown = false
  })
  banner.appendChild(dismissButton)

  document.body.appendChild(banner)
}
