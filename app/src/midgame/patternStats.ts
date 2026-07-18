/**
 * T129: 中盤練習「明確な悪化パターン」(`clearBlunder.ts`)の失敗回数を
 * `localStorage`へ保存・読み込みする「苦手パターン」統計。
 *
 * `app/src/midgame/stageProgress.ts`(T119)と同じ実装パターン
 * (`StorageLike`インターフェース、`isValid*`によるフォールバック検証、
 * `Date.toISOString()`形式の厳密なISO日時検証、T117教訓の「呼び出し側が
 * 非同期処理の前に同期で書き込む」設計)を踏襲する。
 *
 * パターンIDと表示名の対応は`clearBlunder.ts`の`CLEAR_BLUNDER_PATTERN_LABELS`
 * を単一ソースとし(要件2「二重管理しない」)、本モジュールは`ClearBlunderPatternId`
 * をそのままキーに使うだけでラベル文字列自体は持たない。
 */

import { CLEAR_BLUNDER_PATTERN_IDS, type ClearBlunderPatternId } from './clearBlunder.ts'

/** `localStorage` のうち本モジュールが使う最小限のインターフェース(`stageProgress.ts`と同じ)。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `localStorage` に保存する際のキー(要件1)。 */
export const MIDGAME_PATTERN_STATS_STORAGE_KEY = 'othello-trainer:midgame-pattern-stats'

/** 1パターンぶんの失敗記録(要件1)。 */
export interface PatternStatEntry {
  /** これまでの失敗回数(累計)。 */
  readonly failCount: number
  /** 直近に失敗した日時(ISO文字列)。 */
  readonly lastAt: string
}

/** パターンID -> `PatternStatEntry` のマップ(記録の無いパターンはキー自体が存在しない)。 */
export type PatternStats = Readonly<Partial<Record<ClearBlunderPatternId, PatternStatEntry>>>

const EMPTY_STATS: PatternStats = {}

/**
 * `Date.prototype.toISOString()`が実際に出力する形式(`YYYY-MM-DDTHH:mm:ss.sssZ`)
 * の厳密な正規表現(`stageProgress.ts`のT117 redo #1教訓と同じ検証方式)。
 */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * `value`が`Date.toISOString()`形式の日時文字列として厳密に妥当かどうかを
 * 検証する(形式の正規表現に加え、往復一致まで見る。`stageProgress.ts`と同じ)。
 */
function isValidIsoDateTimeString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATETIME_REGEX.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** 回数(`failCount`)として妥当な非負整数かどうかを検証する。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** `value`が`PatternStatEntry`として妥当かどうかを検証する。 */
function isValidEntry(value: unknown): value is PatternStatEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return isNonNegativeInteger(v.failCount) && isValidIsoDateTimeString(v.lastAt)
}

/** `value`が「既知のパターンID -> `PatternStatEntry`」のマップとして妥当かどうかを検証する。 */
function isValidStats(value: unknown): value is PatternStats {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.entries(v).every(
    ([id, entry]) => (CLEAR_BLUNDER_PATTERN_IDS as readonly string[]).includes(id) && isValidEntry(entry),
  )
}

/**
 * 保存済みの苦手パターン統計を読み込む。
 * 未保存(キーが無い)、またはJSONとして壊れている・形が不正な場合は
 * 空のレコード(`{}`)を返す(例外は投げない)。
 */
export function loadPatternStats(storage: StorageLike): PatternStats {
  const raw = storage.getItem(MIDGAME_PATTERN_STATS_STORAGE_KEY)
  if (raw === null) return EMPTY_STATS

  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidStats(parsed) ? parsed : EMPTY_STATS
  } catch {
    return EMPTY_STATS
  }
}

/** 苦手パターン統計を`localStorage`へ保存する(次回起動時も`loadPatternStats`で読み戻せる)。 */
export function savePatternStats(storage: StorageLike, stats: PatternStats): void {
  storage.setItem(MIDGAME_PATTERN_STATS_STORAGE_KEY, JSON.stringify(stats))
}

/**
 * 検出された全パターンID(要件1「表示上限2件でなく検出全件」、
 * `clearBlunder.ts`の`detectAllClearBlunderPatterns`が返すもの)ぶん、
 * 失敗回数を1ずつ加算して`localStorage`へ保存する。
 *
 * `patternIds`が空配列の場合は何も書き込まず現状をそのまま返す(呼び出し元
 * が「ゲートで合格扱いになった手は記録しない」を毎回判定しなくて済むように
 * するための安全弁。実際の呼び出し元は空配列では呼ばない設計)。
 */
export function recordPatternFailures(
  storage: StorageLike,
  patternIds: readonly ClearBlunderPatternId[],
  now: string = new Date().toISOString(),
): PatternStats {
  const stats = loadPatternStats(storage)
  if (patternIds.length === 0) return stats

  const next: Record<string, PatternStatEntry> = { ...stats }
  for (const id of patternIds) {
    const existing = stats[id]
    next[id] = { failCount: (existing?.failCount ?? 0) + 1, lastAt: now }
  }
  const nextStats = next as PatternStats
  savePatternStats(storage, nextStats)
  return nextStats
}

/** 統計を空の状態にリセットする(要件3)。 */
export function resetPatternStats(storage: StorageLike): PatternStats {
  savePatternStats(storage, EMPTY_STATS)
  return EMPTY_STATS
}

/** 表示用の1行(要件2)。 */
export interface PatternStatRow {
  readonly id: ClearBlunderPatternId
  readonly failCount: number
  readonly lastAt: string
}

/** 苦手パターン一覧表示の既定の最大件数(要件2)。 */
export const PATTERN_STATS_DISPLAY_LIMIT = 5

/**
 * `stats`から`failCount`降順で上位`limit`件を返す(要件2)。
 * 同数の場合は`lastAt`降順(より最近失敗した方を先に)、それでも同じなら
 * パターンID昇順で順序を安定させる。
 */
export function topPatternStats(
  stats: PatternStats,
  limit: number = PATTERN_STATS_DISPLAY_LIMIT,
): readonly PatternStatRow[] {
  const rows: PatternStatRow[] = Object.entries(stats)
    .filter((entry): entry is [ClearBlunderPatternId, PatternStatEntry] => entry[1] !== undefined)
    .map(([id, entry]) => ({ id, failCount: entry.failCount, lastAt: entry.lastAt }))

  rows.sort((a, b) => {
    if (b.failCount !== a.failCount) return b.failCount - a.failCount
    if (a.lastAt !== b.lastAt) return b.lastAt.localeCompare(a.lastAt)
    return a.id.localeCompare(b.id)
  })

  return rows.slice(0, limit)
}
