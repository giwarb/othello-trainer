/**
 * 盤面セル評価オーバーレイ(候補手ごとの評価インジケータ、T039)の表示ON/OFF設定を
 * `localStorage` へ保存・読み込みする。
 *
 * `app/src/blunder/storage.ts`(T019)と同じ実装パターン: 実際の`localStorage`に
 * 直接依存せず、`getItem`/`setItem`のみの最小限インターフェース(`StorageLike`)を
 * 介してアクセスする。単体テストでは`Map`ベースのフェイクを注入できる。
 */

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const MOVE_EVAL_OVERLAY_STORAGE_KEY = 'othello-trainer:moveEvalOverlay'

/** オーバーレイ表示の既定値(要件4: デフォルトは非表示)。 */
export const DEFAULT_MOVE_EVAL_OVERLAY_ENABLED = false

/**
 * 保存済みのオーバーレイ表示ON/OFF設定を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・真偽値でない場合は
 * `DEFAULT_MOVE_EVAL_OVERLAY_ENABLED` を返す(例外は投げない)。
 */
export function loadMoveEvalOverlayEnabled(storage: StorageLike): boolean {
  const raw = storage.getItem(MOVE_EVAL_OVERLAY_STORAGE_KEY)
  if (raw === null) return DEFAULT_MOVE_EVAL_OVERLAY_ENABLED

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : DEFAULT_MOVE_EVAL_OVERLAY_ENABLED
  } catch {
    return DEFAULT_MOVE_EVAL_OVERLAY_ENABLED
  }
}

/** オーバーレイ表示ON/OFF設定を `localStorage` へ保存する(次回起動時も読み戻せる)。 */
export function saveMoveEvalOverlayEnabled(storage: StorageLike, enabled: boolean): void {
  storage.setItem(MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(enabled))
}
