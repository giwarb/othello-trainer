// Service Workerの更新検知ロジック(純粋関数部分)。
// 参照: tasks/T062-sw-update-propagation-fix.md
//
// `registerServiceWorker.ts`本体は`navigator.serviceWorker`等の実ブラウザAPIに
// 依存しており、このリポジトリの単体テスト環境(`vitest.config.ts`、'node'環境)
// では動作確認しづらい。判定ロジックだけをここに切り出してテスト可能にする
// (`components/moveEvalOverlayLogic.ts`と同様の切り出し方針)。

/**
 * 新しいService Workerの状態遷移から、ユーザーに更新通知バナーを表示すべきか
 * どうかを判定する。
 *
 * - `hadExistingController`: 新しいワーカーが見つかった時点で、既にこのページを
 *   制御していたService Workerが存在したか。これが`false`の場合は初回インストール
 *   (= ユーザーは端末で初めてこのアプリを開いた/まだ何もキャッシュされていない)
 *   であり、既に最新版を見ているだけなので通知しない。
 * - `workerState`: 新しいワーカー(直前まで`installing`だったもの)の現在の状態。
 *   `sw.js`は`self.skipWaiting()`を呼ぶため`installed`から`activating`へすぐ
 *   進むが、`installing -> installed`の遷移自体は必ず一度経由するため、
 *   `'installed'`になった時点を通知対象とする。
 */
export function shouldNotifyUpdate(hadExistingController: boolean, workerState: ServiceWorkerState): boolean {
  return hadExistingController && workerState === 'installed'
}
