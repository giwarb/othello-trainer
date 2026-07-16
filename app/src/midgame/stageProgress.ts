/**
 * 中盤練習「ステージ一覧」(T119)の挑戦記録を`localStorage`へ保存・読み込みする。
 *
 * `app/src/tsume/stageProgress.ts`(T117、詰めオセロ側)と同じ実装パターン
 * (`StorageLike`インターフェース、`isValid*`によるフォールバック検証)を
 * 踏襲する。T119固有の違いは以下の2点:
 *
 * 1. **判定モードごとに別記録**(要件3): `Puzzle.id`相当の`stageKey`
 *    (`stagePool.ts`の正規化済み局面ハッシュ)に加え、`JudgeMode`
 *    (`'strict'|'standard'|'noReversal'`)を第2のキーとして持つ2階層構造
 *    (`StageProgress = Record<stageKey, Record<JudgeMode, Entry>>`)。
 *    ★の数はそのステージでクリア済みの判定モード数(0〜3)。
 * 2. **T117 redo #1で判明した2つの教訓を最初から反映**
 *    (`tasks/T117-tsume-stage-select.md`のフィードバック・
 *    `tasks/review/T117-tsume-stage-select-codex-review.md`参照):
 *    - 日時バリデーションは`Date.parse`の可否ではなく、`Date.toISOString()`
 *      が実際に出力する形式(`YYYY-MM-DDTHH:mm:ss.sssZ`)の厳密な正規表現
 *      検証+往復一致チェックにする(`isValidIsoDateTimeString`)。
 *    - フィールド相関の整合チェックを行う(`clearCount`と各日時・
 *      `lastResult`の整合性、`isValidEntry`)。
 *    - `recordStageAttempt`を呼ぶ側(`PracticeMode.tsx`)でも、IndexedDB
 *      (`midgamePool`への失敗局面登録)の完了を待たずに`localStorage`へ
 *      同期的に書き込む設計を最初から採用する(T117 redo #1のレースを
 *      未然に防ぐ。詳細は`PracticeMode.tsx`の`recordStageAttemptNow`参照)。
 */

import type { JudgeMode } from './types.ts'

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー。 */
export const MIDGAME_STAGE_PROGRESS_STORAGE_KEY = 'othello-trainer:midgame-stage-progress'

/** 判定モードの既知の値一覧(バリデーション・★数の分母に使う)。 */
export const JUDGE_MODES: readonly JudgeMode[] = ['strict', 'standard', 'noReversal']

/** 1回の挑戦結果。 */
export type StageAttemptResult = 'clear' | 'fail'

/** 1ステージ×1判定モードぶんの挑戦記録。 */
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

/** `stageKey` -> 判定モード -> `StageProgressEntry` の2階層マップ。 */
export type StageProgress = Readonly<Record<string, Readonly<Partial<Record<JudgeMode, StageProgressEntry>>>>>

const EMPTY_PROGRESS: StageProgress = {}

/**
 * `Date.prototype.toISOString()`が実際に出力する形式(`YYYY-MM-DDTHH:mm:ss.sssZ`)
 * の厳密な正規表現(T117 redo #1のcodex-review指摘の反映)。
 */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * `value`が`Date.toISOString()`形式(`YYYY-MM-DDTHH:mm:ss.sssZ`)の
 * 日時文字列として厳密に妥当かどうかを検証する。正規表現の形式チェックに加え、
 * `new Date(value).toISOString()`で往復させて元の文字列と一致するかまで見る
 * (例: `"2026-02-30T00:00:00.000Z"`のような、形式は正しいが暦として存在しない
 * 日付は`Date`が別の日付へ繰り上げてしまい往復一致しないため弾かれる)。
 */
function isValidIsoDateTimeString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATETIME_REGEX.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** 回数(`clearCount`/`failCount`)として妥当な非負整数かどうかを検証する。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * `value`が`StageProgressEntry`として妥当かどうかを検証する。
 * 型・意味的制約(非負整数・厳密なISO日時)に加え、フィールド相関の整合性
 * まで検証する(T117 redo #1のcodex-review指摘(b)を最初から反映):
 * - `clearCount === 0`なのにクリア日時(`firstClearedAt`/`lastClearedAt`)が
 *   設定されている場合は不正。
 * - `clearCount > 0`なのに`firstClearedAt`/`lastClearedAt`の**どちらか一方でも**
 *   `null`の場合は不正(クリア済みならスキーマ上どちらの日時も必須。
 *   redo #1: codex-review指摘(b)2で、修正前は「両方`null`」の場合しか
 *   弾けておらず、片方だけ`null`の破損データが有効値として通ってしまう
 *   欠陥があった)。
 * - `lastResult === 'clear'`なのに`clearCount === 0`の場合は不正
 *   (直近の結果がクリアなら、クリア回数は最低1回あるはず)。
 */
function isValidEntry(value: unknown): value is StageProgressEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>

  const baseValid =
    (v.firstClearedAt === null || isValidIsoDateTimeString(v.firstClearedAt)) &&
    (v.lastClearedAt === null || isValidIsoDateTimeString(v.lastClearedAt)) &&
    isNonNegativeInteger(v.clearCount) &&
    isNonNegativeInteger(v.failCount) &&
    isValidIsoDateTimeString(v.lastAttemptAt) &&
    (v.lastResult === 'clear' || v.lastResult === 'fail')
  if (!baseValid) return false

  const clearCount = v.clearCount as number
  const firstClearedAt = v.firstClearedAt as string | null
  const lastClearedAt = v.lastClearedAt as string | null
  const lastResult = v.lastResult as StageAttemptResult

  if (clearCount === 0 && (firstClearedAt !== null || lastClearedAt !== null)) return false
  if (clearCount > 0 && (firstClearedAt === null || lastClearedAt === null)) return false
  if (lastResult === 'clear' && clearCount === 0) return false

  return true
}

/** `value`が「判定モード文字列 -> `StageProgressEntry`」のマップとして妥当かどうかを検証する。 */
function isValidModeRecord(value: unknown): value is Readonly<Partial<Record<JudgeMode, StageProgressEntry>>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.entries(v).every(
    ([mode, entry]) => (JUDGE_MODES as readonly string[]).includes(mode) && isValidEntry(entry),
  )
}

function isValidProgress(value: unknown): value is StageProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isValidModeRecord)
}

/**
 * 保存済みのステージ挑戦記録を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・形が不正な場合は
 * 空のレコード(`{}`)を返す(例外は投げない)。
 */
export function loadStageProgress(storage: StorageLike): StageProgress {
  const raw = storage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)
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
  storage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(progress))
}

/**
 * 1回の挑戦結果(`stageKey`・`mode`について`result`)を記録し、更新後の全体を
 * 返して`localStorage`へ保存する(要件3)。既存エントリがあれば更新、
 * 無ければ新規作成。呼び出し側(`PracticeMode.tsx`)は、IndexedDB
 * (`midgamePool`への失敗局面登録)より前にこの関数を同期的に呼ぶこと
 * (T117 redo #1のレース対策、`PracticeMode.tsx`の`recordStageAttemptNow`参照)。
 */
export function recordStageAttempt(
  storage: StorageLike,
  stageKey: string,
  mode: JudgeMode,
  result: StageAttemptResult,
  now: string = new Date().toISOString(),
): StageProgress {
  const progress = loadStageProgress(storage)
  const modeRecord = progress[stageKey] ?? {}
  const existing = modeRecord[mode]
  const isClear = result === 'clear'

  const entry: StageProgressEntry = {
    firstClearedAt: isClear ? (existing?.firstClearedAt ?? now) : (existing?.firstClearedAt ?? null),
    lastClearedAt: isClear ? now : (existing?.lastClearedAt ?? null),
    clearCount: (existing?.clearCount ?? 0) + (isClear ? 1 : 0),
    failCount: (existing?.failCount ?? 0) + (isClear ? 0 : 1),
    lastAttemptAt: now,
    lastResult: result,
  }

  const nextModeRecord = { ...modeRecord, [mode]: entry }
  const next: StageProgress = { ...progress, [stageKey]: nextModeRecord }
  saveStageProgress(storage, next)
  return next
}

/**
 * `stageKey`について、クリア済みの判定モード数(★の数、0〜`JUDGE_MODES.length`)
 * を返す(要件3)。
 */
export function stageStarCount(progress: StageProgress, stageKey: string): number {
  const modeRecord = progress[stageKey]
  if (!modeRecord) return 0
  let count = 0
  for (const mode of JUDGE_MODES) {
    if ((modeRecord[mode]?.clearCount ?? 0) > 0) count++
  }
  return count
}

/** ステージ一覧セルの表示状態(要件2、`app/src/tsume/stageProgress.ts`の3状態モデルを踏襲)。 */
export type StageStatus = 'unattempted' | 'attempted' | 'cleared'

/**
 * `stageKey`の総合状態を導出する純粋関数。
 * - 記録が無ければ`'unattempted'`(未挑戦)。
 * - ★が1つ以上あれば`'cleared'`(いずれかの判定モードでクリア済み)。
 * - ★0だが挑戦記録(失敗のみ)があれば`'attempted'`(挑戦済み未クリア)。
 */
export function stageStatus(progress: StageProgress, stageKey: string): StageStatus {
  if (stageStarCount(progress, stageKey) > 0) return 'cleared'
  const modeRecord = progress[stageKey]
  if (modeRecord && Object.keys(modeRecord).length > 0) return 'attempted'
  return 'unattempted'
}

/** `stageKey`・`mode`単位での状態(結果画面等で「このモードは既にクリア済みか」を見るのに使う)。 */
export function stageStatusForMode(progress: StageProgress, stageKey: string, mode: JudgeMode): StageStatus {
  const entry = progress[stageKey]?.[mode]
  if (!entry) return 'unattempted'
  if (entry.clearCount > 0) return 'cleared'
  return 'attempted'
}
