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

/**
 * 中盤練習(`midgame/PracticeMode.tsx`)専用のオーバーレイ表示ON/OFF設定(T142)。
 *
 * T141で候補手評価オーバーレイのON/OFFチェックを撤去し常時表示化したが、
 * ユーザー報告により切り替え自体は復活させることになった。ただし
 * 「評価値は常に出ているように」という前指示(T141要件3)も維持するため、
 * 上記の対局モード等と共有する`MOVE_EVAL_OVERLAY_STORAGE_KEY`(既定OFF)とは
 * 別キー・別既定値(既定ON)で保持する。読み書きの実装パターン自体は同一。
 */
export const MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY = 'othello-trainer:midgameMoveEvalOverlay'

/** 中盤練習のオーバーレイ表示の既定値(T142要件1: 既定はON)。 */
export const DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED = true

/**
 * 保存済みの中盤練習向けオーバーレイ表示ON/OFF設定を読み込む。
 * 未保存・壊れたJSON・真偽値でない場合は`DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED`
 * (=`true`)を返す(例外は投げない)。
 */
export function loadMidgameMoveEvalOverlayEnabled(storage: StorageLike): boolean {
  const raw = storage.getItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY)
  if (raw === null) return DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED
  } catch {
    return DEFAULT_MIDGAME_MOVE_EVAL_OVERLAY_ENABLED
  }
}

/** 中盤練習向けオーバーレイ表示ON/OFF設定を `localStorage` へ保存する(次回起動時も読み戻せる)。 */
export function saveMidgameMoveEvalOverlayEnabled(storage: StorageLike, enabled: boolean): void {
  storage.setItem(MIDGAME_MOVE_EVAL_OVERLAY_STORAGE_KEY, JSON.stringify(enabled))
}
