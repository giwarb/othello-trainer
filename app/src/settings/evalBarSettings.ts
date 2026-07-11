/**
 * 対局モード(`PlayMode`、T077)の「現在の評価値」バー(`midgame/EvalBar.tsx`を
 * 転用)の表示ON/OFF設定を`localStorage`へ保存・読み込みする。
 *
 * `app/src/settings/moveEvalOverlaySettings.ts`(T039)と全く同じ実装パターン:
 * 実際の`localStorage`に直接依存せず、`getItem`/`setItem`のみの最小限
 * インターフェース(`StorageLike`)を介してアクセスする。単体テストでは
 * `Map`ベースのフェイクを注入できる。
 */

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const EVAL_BAR_STORAGE_KEY = 'othello-trainer:playEvalBar'

/** 評価値バー表示の既定値(既定は非表示。候補手評価オーバーレイと同じ方針)。 */
export const DEFAULT_EVAL_BAR_ENABLED = false

/**
 * 保存済みの評価値バー表示ON/OFF設定を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・真偽値でない場合は
 * `DEFAULT_EVAL_BAR_ENABLED` を返す(例外は投げない)。
 */
export function loadEvalBarEnabled(storage: StorageLike): boolean {
  const raw = storage.getItem(EVAL_BAR_STORAGE_KEY)
  if (raw === null) return DEFAULT_EVAL_BAR_ENABLED

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : DEFAULT_EVAL_BAR_ENABLED
  } catch {
    return DEFAULT_EVAL_BAR_ENABLED
  }
}

/** 評価値バー表示ON/OFF設定を `localStorage` へ保存する(次回起動時も読み戻せる)。 */
export function saveEvalBarEnabled(storage: StorageLike, enabled: boolean): void {
  storage.setItem(EVAL_BAR_STORAGE_KEY, JSON.stringify(enabled))
}
