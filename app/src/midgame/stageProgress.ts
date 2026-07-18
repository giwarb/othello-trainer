/**
 * 中盤練習「ステージ一覧」(T119、T141で★制へ全面改訂)の挑戦記録を
 * `localStorage`へ保存・読み込みする。
 *
 * ## T141での変更点
 *
 * 旧実装(T119)は「ステージキー × 判定モード(`strict`/`standard`/`noReversal`)」の
 * 2階層構造で、★の数は「クリア済みの判定モード数」だった。T141で判定モード
 * 選択UI自体を廃止し、1ステージにつき単一の★0〜3(`stageStarJudge.ts`の
 * `computeStageStars`が返す)を記録するフラットな構造に置き換える。
 *
 * `loadStageProgress`/`stageStatus`は**関数シグネチャ・意味論を保ったまま**
 * 実装を差し替えている(`app.tsx`のホーム実績行(T137)がこの2つをそのまま
 * 呼んでおり、T141は`app.tsx`本体に触れないスコープのため)。`stageStatus`の
 * `'cleared'`の意味が「いずれかの判定モードでクリア済み」から「`bestStars >= 1`」
 * に変わる点が要件5の「クリア」定義更新そのものであり、`app.tsx`側は無改造で
 * 新定義に追従する。
 *
 * ## 新localStorageキーと旧記録の一度きりの移行(要件5)
 *
 * 新記録は`MIDGAME_STAGE_STARS_STORAGE_KEY`(`othello-trainer:midgame-stage-stars`)
 * に保存する。旧キー(`MIDGAME_STAGE_PROGRESS_STORAGE_KEY`、
 * `othello-trainer:midgame-stage-progress`)は**削除しない**(ユーザー指示
 * 「旧データは消さない」、T114の教訓「ユーザーはデータ消失に極めて敏感」を
 * 踏まえた保守的な方針)。`loadStageProgress`は初回呼び出し時(移行済みマーカー
 * `MIDGAME_STAGE_STARS_MIGRATED_KEY`が無い場合)に旧記録を読み、いずれかの
 * 判定モードでクリア済み(`clearCount > 0`)のステージを`bestStars: 1`として
 * 新記録へ**一度だけ**シードし、移行済みマーカーを立てる(以後は素通しで
 * 新記録を読むだけになる)。新記録に既にエントリがあるステージは上書きしない
 * (実運用ではまだ存在しないはずだが、防御的に)。
 *
 * ## `failCount`フィールドについて(タスク仕様のスキーマからの小さな拡張)
 *
 * `tasks/T141-midgame-stage-stars.md`要件5が明示するスキーマは
 * `{ bestStars, attempts, lastResultStars, lastAttemptAt, firstClearedAt }`だが、
 * 要件6が維持する復習フィルタ「失敗あり」(`settings/reviewFilter.ts`の
 * `matchesReviewFilter`、"現在の状態を問わない累積の失敗経験そのものを指す"、
 * T130由来の既存語彙)を再現するには「このステージでこれまで★0という結果に
 * なった回数」が要る。`attempts`(総挑戦回数)だけでは
 * 「1回目で失敗し2回目でクリアした」ケースと「1回目でいきなりクリアした」
 * ケースを区別できないため、`failCount`(★0だった挑戦回数の累計)を1フィールド
 * 追加している。新規追加のフィールドであり、指定スキーマの意味(★・挑戦回数・
 * 直近結果・日時)を変えるものではない。
 *
 * ## `StorageLike`・妥当性検証の実装パターン
 *
 * `app/src/tsume/stageProgress.ts`・T117 redo #1の教訓(`Date.toISOString()`の
 * 厳密な正規表現+往復一致チェック、フィールド相関の整合チェック)を踏襲する。
 */

import type { Stars } from './stageStarJudge.ts'

/** `localStorage` のうち本モジュールが使う最小限のインターフェース。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 新記録(★制)の`localStorage`キー(要件5)。 */
export const MIDGAME_STAGE_STARS_STORAGE_KEY = 'othello-trainer:midgame-stage-stars'

/** 旧記録(判定モード別2階層、T119)の`localStorage`キー。移行元としてのみ読む。 */
export const MIDGAME_STAGE_PROGRESS_STORAGE_KEY = 'othello-trainer:midgame-stage-progress'

/** 「旧記録からの一度きりの移行を実行済みか」を示すマーカーキー。 */
export const MIDGAME_STAGE_STARS_MIGRATED_KEY = 'othello-trainer:midgame-stage-stars-migrated'

/** 1ステージぶんの挑戦記録(要件5のスキーマ + `failCount`拡張、上記コメント参照)。 */
export interface StageStarEntry {
  /** これまでの最高★(0〜3)。挑戦のたびに単調非減少で更新される。 */
  readonly bestStars: Stars
  /** 総挑戦回数。 */
  readonly attempts: number
  /** ★0(クリア失敗)だった挑戦回数の累計(上記コメント参照、新規追加フィールド)。 */
  readonly failCount: number
  /** 直近の挑戦で獲得した★。 */
  readonly lastResultStars: Stars
  /** 直近の挑戦日時(ISO文字列)。 */
  readonly lastAttemptAt: string
  /** 初めて★1以上を獲得した日時(ISO文字列)。未クリアなら`null`。 */
  readonly firstClearedAt: string | null
}

/** `stageKey` -> `StageStarEntry` のフラットマップ。 */
export type StageProgress = Readonly<Record<string, StageStarEntry>>

const EMPTY_PROGRESS: StageProgress = {}

/**
 * `Date.prototype.toISOString()`が実際に出力する形式(`YYYY-MM-DDTHH:mm:ss.sssZ`)
 * の厳密な正規表現(T117 redo #1教訓の踏襲)。
 */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isValidIsoDateTimeString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATETIME_REGEX.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isStars(value: unknown): value is Stars {
  return value === 0 || value === 1 || value === 2 || value === 3
}

/**
 * `value`が`StageStarEntry`として妥当かどうかを検証する。
 * フィールド相関の整合性チェック(T117 redo #1の教訓を踏襲):
 * - `bestStars === 0`なのに`firstClearedAt`が設定されていれば不正。
 * - `bestStars >= 1`なのに`firstClearedAt`が`null`なら不正。
 * - `attempts === 0`なのに`failCount > 0`、または`attempts < failCount`なら不正。
 */
function isValidEntry(value: unknown): value is StageStarEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>

  const baseValid =
    isStars(v.bestStars) &&
    isNonNegativeInteger(v.attempts) &&
    isNonNegativeInteger(v.failCount) &&
    isStars(v.lastResultStars) &&
    isValidIsoDateTimeString(v.lastAttemptAt) &&
    (v.firstClearedAt === null || isValidIsoDateTimeString(v.firstClearedAt))
  if (!baseValid) return false

  const bestStars = v.bestStars as Stars
  const attempts = v.attempts as number
  const failCount = v.failCount as number
  const firstClearedAt = v.firstClearedAt as string | null

  if (bestStars === 0 && firstClearedAt !== null) return false
  if (bestStars >= 1 && firstClearedAt === null) return false
  if (failCount > attempts) return false

  return true
}

function isValidProgress(value: unknown): value is StageProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isValidEntry)
}

// --- 旧記録(判定モード別2階層、T119)の読み取り専用の妥当性検証(移行用) ---

const LEGACY_JUDGE_MODES = ['strict', 'standard', 'noReversal'] as const

interface LegacyStageProgressEntry {
  readonly firstClearedAt: string | null
  readonly lastClearedAt: string | null
  readonly clearCount: number
  readonly failCount: number
  readonly lastAttemptAt: string
  readonly lastResult: 'clear' | 'fail'
}

function isValidLegacyEntry(value: unknown): value is LegacyStageProgressEntry {
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

type LegacyStageProgress = Readonly<Record<string, Readonly<Partial<Record<string, LegacyStageProgressEntry>>>>>

function isValidLegacyProgress(value: unknown): value is LegacyStageProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((modeRecord) => {
    if (typeof modeRecord !== 'object' || modeRecord === null || Array.isArray(modeRecord)) return false
    return Object.entries(modeRecord as Record<string, unknown>).every(
      ([mode, entry]) => (LEGACY_JUDGE_MODES as readonly string[]).includes(mode) && isValidLegacyEntry(entry),
    )
  })
}

/**
 * 旧記録(`MIDGAME_STAGE_PROGRESS_STORAGE_KEY`)を読み、いずれかの判定モードで
 * クリア済み(`clearCount > 0`)だったステージを`bestStars: 1`として`progress`へ
 * シードする(要件5「旧記録でいずれかのモードのクリアがあるステージは
 * `bestStars>=1`として一度だけシード」)。`progress`に既にエントリがある
 * ステージは上書きしない。旧記録が無い・壊れている場合は何もしない
 * (例外は投げない)。
 */
function migrateFromLegacyProgress(storage: StorageLike, progress: StageProgress): StageProgress {
  const raw = storage.getItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY)
  if (raw === null) return progress

  let legacy: unknown
  try {
    legacy = JSON.parse(raw)
  } catch {
    return progress
  }
  if (!isValidLegacyProgress(legacy)) return progress

  const next: Record<string, StageStarEntry> = { ...progress }
  for (const [stageKey, modeRecord] of Object.entries(legacy)) {
    if (next[stageKey]) continue // 新記録に既存エントリがあれば上書きしない(防御的)

    const clearedEntries = LEGACY_JUDGE_MODES.map((mode) => modeRecord[mode]).filter(
      (entry): entry is LegacyStageProgressEntry => !!entry && entry.clearCount > 0,
    )
    if (clearedEntries.length === 0) continue

    // 複数モードでクリア済みの場合、最も早い初クリア日時を代表値として使う。
    const seedAt = clearedEntries.reduce(
      (earliest, entry) => (entry.firstClearedAt && entry.firstClearedAt < earliest ? entry.firstClearedAt : earliest),
      clearedEntries[0]!.firstClearedAt ?? clearedEntries[0]!.lastAttemptAt,
    )

    next[stageKey] = {
      bestStars: 1,
      attempts: 1,
      failCount: 0,
      lastResultStars: 1,
      lastAttemptAt: seedAt,
      firstClearedAt: seedAt,
    }
  }
  return next
}

/**
 * 保存済みのステージ挑戦記録を読み込む(要件5)。
 *
 * 初回呼び出し(移行済みマーカーが無い)の場合、旧記録からの一度きりの
 * シード(`migrateFromLegacyProgress`)を行い、その結果を新キーへ書き戻して
 * マーカーを立ててから返す。2回目以降は新キーをそのまま読むだけ。
 *
 * 新キーの内容が未保存・JSONとして壊れている・形が不正な場合は空のレコード
 * (`{}`)として扱う(例外は投げない)。
 */
export function loadStageProgress(storage: StorageLike): StageProgress {
  const raw = storage.getItem(MIDGAME_STAGE_STARS_STORAGE_KEY)
  let progress: StageProgress = EMPTY_PROGRESS
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      progress = isValidProgress(parsed) ? parsed : EMPTY_PROGRESS
    } catch {
      progress = EMPTY_PROGRESS
    }
  }

  if (storage.getItem(MIDGAME_STAGE_STARS_MIGRATED_KEY) !== null) {
    return progress
  }

  try {
    const migrated = migrateFromLegacyProgress(storage, progress)
    storage.setItem(MIDGAME_STAGE_STARS_MIGRATED_KEY, '1')
    if (migrated !== progress) {
      storage.setItem(MIDGAME_STAGE_STARS_STORAGE_KEY, JSON.stringify(migrated))
    }
    return migrated
  } catch (error) {
    console.error('中盤練習ステージ記録の旧データ移行に失敗しました', error)
    return progress
  }
}

/** ステージ挑戦記録を`localStorage`へ保存する(次回起動時も`loadStageProgress`で読み戻せる)。 */
export function saveStageProgress(storage: StorageLike, progress: StageProgress): void {
  storage.setItem(MIDGAME_STAGE_STARS_STORAGE_KEY, JSON.stringify(progress))
}

/**
 * 1回の挑戦結果(★数)を記録し、更新後の全体を返して`localStorage`へ保存する
 * (要件5)。`bestStars`は単調非減少(既存の方が高ければそちらを維持)。
 * 呼び出し側(`PracticeMode.tsx`)は他の非同期処理より前に同期的にこれを呼ぶこと
 * (T117 redo #1の教訓)。
 */
export function recordStageAttempt(
  storage: StorageLike,
  stageKey: string,
  stars: Stars,
  now: string = new Date().toISOString(),
): StageProgress {
  const progress = loadStageProgress(storage)
  const existing = progress[stageKey]
  const bestStars = Math.max(existing?.bestStars ?? 0, stars) as Stars

  const entry: StageStarEntry = {
    bestStars,
    attempts: (existing?.attempts ?? 0) + 1,
    failCount: (existing?.failCount ?? 0) + (stars === 0 ? 1 : 0),
    lastResultStars: stars,
    lastAttemptAt: now,
    firstClearedAt: existing?.firstClearedAt ?? (stars >= 1 ? now : null),
  }

  const next: StageProgress = { ...progress, [stageKey]: entry }
  saveStageProgress(storage, next)
  return next
}

/** `stageKey`の最高★(0〜3、グリッド表示に使う、要件5)。記録が無ければ`0`。 */
export function stageBestStars(progress: StageProgress, stageKey: string): Stars {
  return progress[stageKey]?.bestStars ?? 0
}

/** `stageKey`の累計失敗回数(★0だった回数、復習フィルタ「失敗あり」に使う)。記録が無ければ`0`。 */
export function stageFailCount(progress: StageProgress, stageKey: string): number {
  return progress[stageKey]?.failCount ?? 0
}

/** ステージ一覧セルの表示状態(`app/src/tsume/stageProgress.ts`の3状態モデルを踏襲)。 */
export type StageStatus = 'unattempted' | 'attempted' | 'cleared'

/**
 * `stageKey`の総合状態を導出する純粋関数(要件5「クリア」定義の更新: `app.tsx`の
 * ホーム実績行・進捗バーは本関数を無改造のまま呼び続けるだけで新定義に従う)。
 * - 記録が無ければ`'unattempted'`(未挑戦)。
 * - `bestStars >= 1`なら`'cleared'`。
 * - `bestStars === 0`だが挑戦記録があれば`'attempted'`(挑戦済み未クリア)。
 */
export function stageStatus(progress: StageProgress, stageKey: string): StageStatus {
  const entry = progress[stageKey]
  if (!entry) return 'unattempted'
  if (entry.bestStars >= 1) return 'cleared'
  return 'attempted'
}
