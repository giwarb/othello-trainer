/**
 * 詰めオセロ「ステージ一覧」(T117)の挑戦記録を `localStorage` へ保存・読み込みする。
 *
 * `app/src/blunder/storage.ts`・`app/src/settings/moveEvalOverlaySettings.ts`と
 * 同じ実装パターン: 実際の`localStorage`に直接依存せず、`getItem`/`setItem`のみの
 * 最小限インターフェース(`StorageLike`)を介してアクセスする。単体テストでは
 * `Map`ベースのフェイクを注入できる。
 *
 * `tsume/stats.ts`のIndexedDB `tsumeAttempts`ストア(挑戦ごとの詳細ログ、
 * タグ別正答率の集計に使う)とは別物。こちらは`Puzzle.id`をキーにした
 * 「そのステージを今までに何回クリア/失敗したか」の集計を`localStorage`に
 * 持つ軽量な記録で、ステージ一覧のクリア済みマーク表示と、将来の復習モード
 * (未クリア・苦手ステージの優先出題等)のための土台(要件3)。
 *
 * 要件5(ID安定性の注記): `app/public/puzzles.json`は`puzzles:build`で
 * 再生成されるとID(`Puzzle.id`、`"tsume-N"`形式)の集合が変わりうる
 * (問題の追加・削除・並び替えにより既存IDが別の問題を指すようになったり、
 * 消滅したりしうる)。本モジュールは`Puzzle.id`をそのままキーに使うため、
 * 再生成後は「現存しないIDの記録」が残り続ける可能性があるが、これは
 * エラーにしない(呼び出し側は現在のプール`Puzzle[]`を反復して`stageStatus`を
 * 引くだけなので、存在しないIDのレコードは単に参照されず無害。明示的な
 * 削除・移行処理は行わない、スコープ外)。
 */

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const TSUME_STAGE_PROGRESS_STORAGE_KEY = 'othello-trainer:tsume-stage-progress'

/** 1回の挑戦結果。 */
export type StageAttemptResult = 'clear' | 'fail'

/** 1問(`Puzzle.id`)ぶんの挑戦記録。 */
export interface StageProgressEntry {
  /** 初めてクリアした日時(ISO文字列)。未クリアなら`null`。 */
  readonly firstClearedAt: string | null
  /** 直近にクリアした日時(ISO文字列)。未クリアなら`null`。 */
  readonly lastClearedAt: string | null
  /** クリア回数(累計)。 */
  readonly clearCount: number
  /** 失敗回数(累計)。 */
  readonly failCount: number
  /** 直近の挑戦日時(クリア・失敗を問わない、ISO文字列)。 */
  readonly lastAttemptAt: string
  /** 直近の挑戦結果。 */
  readonly lastResult: StageAttemptResult
}

/** `Puzzle.id` -> `StageProgressEntry` のマップ。 */
export type StageProgress = Readonly<Record<string, StageProgressEntry>>

const EMPTY_PROGRESS: StageProgress = {}

/**
 * `value`が空でない、`Date.parse`で解釈可能な日時文字列かどうかを検証する
 * (ISO 8601文字列を主に想定するが、`Date.parse`が受理する範囲で判定する
 * 実用上十分な検証。redo #1: codex-review指摘bで、空文字列や`"not-a-date"`
 * のような文字列が日時として誤って有効値扱いされていた問題への対応)。
 */
function isValidIsoDateTimeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

/** 回数(`clearCount`/`failCount`)として妥当な非負整数かどうかを検証する。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * `value`が`StageProgressEntry`として妥当かどうかを検証する。
 * redo #1(codex-review指摘b): 単に型が合っているだけでなく、スキーマの
 * 意味的制約(回数は非負整数、日時は解釈可能な文字列)まで検証する
 * (以前は`clearCount: -1`や`failCount: 0.5`、`lastAttemptAt: ""`のような
 * 値も「有限な数値/文字列」というだけで有効値として通ってしまっていた)。
 */
function isValidEntry(value: unknown): value is StageProgressEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.firstClearedAt === null || isValidIsoDateTimeString(v.firstClearedAt)) &&
    (v.lastClearedAt === null || isValidIsoDateTimeString(v.lastClearedAt)) &&
    isNonNegativeInteger(v.clearCount) &&
    isNonNegativeInteger(v.failCount) &&
    isValidIsoDateTimeString(v.lastAttemptAt) &&
    (v.lastResult === 'clear' || v.lastResult === 'fail')
  )
}

function isValidProgress(value: unknown): value is StageProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isValidEntry)
}

/**
 * 保存済みのステージ挑戦記録を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・形が不正な場合は
 * 空のレコード(`{}`)を返す(例外は投げない)。
 */
export function loadStageProgress(storage: StorageLike): StageProgress {
  const raw = storage.getItem(TSUME_STAGE_PROGRESS_STORAGE_KEY)
  if (raw === null) return EMPTY_PROGRESS

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidProgress(parsed) ? parsed : EMPTY_PROGRESS
  } catch {
    return EMPTY_PROGRESS
  }
}

/** ステージ挑戦記録を`localStorage`へ保存する(次回起動時も`loadStageProgress`で読み戻せる)。 */
export function saveStageProgress(storage: StorageLike, progress: StageProgress): void {
  storage.setItem(TSUME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(progress))
}

/**
 * 1回の挑戦結果(`puzzleId`について`result`)を記録し、更新後の全体を返して
 * `localStorage`へ保存する(要件3)。既存エントリがあれば更新、無ければ新規作成。
 * ステージ一覧経由に限らず、難易度別・ランダム・デイリーいずれの出題経路からの
 * 挑戦でも呼び出すこと(同じ`Puzzle.id`であれば記録は共通)。
 */
export function recordStageAttempt(
  storage: StorageLike,
  puzzleId: string,
  result: StageAttemptResult,
  now: string = new Date().toISOString(),
): StageProgress {
  const progress = loadStageProgress(storage)
  const existing = progress[puzzleId]
  const isClear = result === 'clear'

  const entry: StageProgressEntry = {
    firstClearedAt: isClear ? (existing?.firstClearedAt ?? now) : (existing?.firstClearedAt ?? null),
    lastClearedAt: isClear ? now : (existing?.lastClearedAt ?? null),
    clearCount: (existing?.clearCount ?? 0) + (isClear ? 1 : 0),
    failCount: (existing?.failCount ?? 0) + (isClear ? 0 : 1),
    lastAttemptAt: now,
    lastResult: result,
  }

  const next: StageProgress = { ...progress, [puzzleId]: entry }
  saveStageProgress(storage, next)
  return next
}

/** ステージ一覧セルの表示状態(要件1)。 */
export type StageStatus = 'unattempted' | 'attempted' | 'cleared'

/**
 * `progress`から`puzzleId`のステージ状態を導出する純粋関数。
 * - 記録が無ければ`'unattempted'`(未挑戦)。
 * - クリア回数が1回以上あれば`'cleared'`(クリア済み、失敗を挟んでいても
 *   一度でもクリアしていれば`cleared`のまま。ユーザー要望の「クリア済みは
 *   そうとわかる」を素直に満たす設計)。
 * - クリア未経験だが挑戦記録があれば`'attempted'`(挑戦済み未クリア)。
 */
export function stageStatus(progress: StageProgress, puzzleId: string): StageStatus {
  const entry = progress[puzzleId]
  if (!entry) return 'unattempted'
  if (entry.clearCount > 0) return 'cleared'
  return 'attempted'
}
