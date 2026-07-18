/**
 * ステージ一覧グリッド(詰めオセロ`tsume/PlayMode.tsx`・中盤練習
 * `midgame/PracticeMode.tsx`)に共通の復習フィルタ(T130)。
 *
 * 両モードとも「すべて/未挑戦/失敗あり/未クリア/クリア済み」の5種類の
 * フィルタチップをグリッド直前に表示し、選択状態を`localStorage`へ永続化する
 * (要件1・3)。判定対象の`StageProgress`の型は詰めオセロ・中盤練習で異なる
 * (中盤練習は判定モードごとの2階層構造、T119、要件2「現在選択中の判定モードの
 * 記録で判定する」)ため、本モジュールはステージ1件ぶんの「状態
 * (`'unattempted'|'attempted'|'cleared'`、`tsume/stageProgress.ts`・
 * `midgame/stageProgress.ts`の`StageStatus`と構造的に同じ)」と「失敗回数」
 * という共通の形に抽象化した`matchesReviewFilter`のみを提供し、各
 * `StageProgress`からその形を導出する処理(`stageStatus`・`stageStatusForMode`
 * 等)は呼び出し側に委ねる。
 *
 * 永続化ロジックは`app/src/settings/moveEvalOverlaySettings.ts`・
 * `app/src/midgame/judgeModeStorage.ts`と同じ実装パターン(`StorageLike`
 * インターフェース経由でのアクセス、壊れた値は例外を投げず既定値
 * `'all'`へフォールバック)。詰めオセロ・中盤練習で別々の`localStorage`
 * キーを使う(`TSUME_REVIEW_FILTER_STORAGE_KEY`・
 * `MIDGAME_REVIEW_FILTER_STORAGE_KEY`)ため、`loadReviewFilter`/
 * `saveReviewFilter`はキーを引数に取る。
 */

export type ReviewFilter = 'all' | 'unattempted' | 'hasFailure' | 'uncleared' | 'cleared'

/**
 * グリッドセル1件ぶんの状態(`tsume/stageProgress.ts`・
 * `midgame/stageProgress.ts`の`StageStatus`と構造的に同じ)。
 */
export type ReviewableStatus = 'unattempted' | 'attempted' | 'cleared'

/** フィルタチップのUI表示順・ラベル(要件1)。 */
export const REVIEW_FILTER_OPTIONS: readonly { value: ReviewFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'unattempted', label: '未挑戦' },
  { value: 'hasFailure', label: '失敗あり' },
  { value: 'uncleared', label: '未クリア' },
  { value: 'cleared', label: 'クリア済み' },
]

const VALID_REVIEW_FILTERS: readonly ReviewFilter[] = REVIEW_FILTER_OPTIONS.map((option) => option.value)

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 詰めオセロ(`tsume/PlayMode.tsx`)のフィルタ選択を保存する`localStorage`キー。 */
export const TSUME_REVIEW_FILTER_STORAGE_KEY = 'othello-trainer:tsume-review-filter'

/** 中盤練習(`midgame/PracticeMode.tsx`)のフィルタ選択を保存する`localStorage`キー。 */
export const MIDGAME_REVIEW_FILTER_STORAGE_KEY = 'othello-trainer:midgame-review-filter'

/** 既定のフィルタ(絞り込みなし)。 */
export const DEFAULT_REVIEW_FILTER: ReviewFilter = 'all'

function isValidReviewFilter(value: unknown): value is ReviewFilter {
  return typeof value === 'string' && (VALID_REVIEW_FILTERS as readonly string[]).includes(value)
}

/**
 * 保存済みのフィルタ選択を読み込む(要件3)。未保存(キーが無い)、または
 * JSONとして壊れている・既知の値でない場合は`DEFAULT_REVIEW_FILTER`
 * (`'all'`)を返す(例外は投げない)。
 */
export function loadReviewFilter(storage: StorageLike, key: string): ReviewFilter {
  const raw = storage.getItem(key)
  if (raw === null) return DEFAULT_REVIEW_FILTER

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidReviewFilter(parsed) ? parsed : DEFAULT_REVIEW_FILTER
  } catch {
    return DEFAULT_REVIEW_FILTER
  }
}

/** フィルタ選択を`localStorage`へ保存する(次回起動時も`loadReviewFilter`で読み戻せる、要件3)。 */
export function saveReviewFilter(storage: StorageLike, key: string, filter: ReviewFilter): void {
  storage.setItem(key, JSON.stringify(filter))
}

/**
 * ステージの状態(`status`)と累計失敗回数(`failCount`)が`filter`に
 * 一致するかどうかを判定する純粋関数(要件1)。
 * - `'all'`: 常に一致。
 * - `'unattempted'`: 挑戦記録が無い(`status === 'unattempted'`)。
 * - `'hasFailure'`: 失敗回数が1回以上(クリア済みでも過去に失敗を経ていれば
 *   対象。「失敗あり」は現在の状態を問わない累積の失敗経験そのものを指す)。
 * - `'uncleared'`: クリア済みでない(未挑戦・挑戦済み未クリアの両方を含む)。
 * - `'cleared'`: クリア済み。
 */
export function matchesReviewFilter(status: ReviewableStatus, failCount: number, filter: ReviewFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'unattempted':
      return status === 'unattempted'
    case 'hasFailure':
      return failCount > 0
    case 'uncleared':
      return status !== 'cleared'
    case 'cleared':
      return status === 'cleared'
  }
}
