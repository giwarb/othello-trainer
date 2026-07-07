/**
 * 定石練習モードの習熟管理(SRS: Spaced Repetition System)ロジック(T020)。
 *
 * 設計書 `othello-trainer-design.md` §2.6.3「習熟管理(SRS)」の簡易版。
 * 記録単位は「ラインの終端ノード」(`JosekiLine.id`、実質 `name` と同じ)。
 * SM-2の考え方(ease factor 1.3〜2.5、正解時は `interval *= ease`、
 * 失敗時は `interval` を1日にリセット)を踏襲した簡略版で、次回出題日
 * (`dueDate`)を計算する。
 *
 * 本モジュールは日付操作・純粋計算のみを行い、永続化は `db.ts` が担当する
 * (関心の分離。単体テストしやすくするため)。
 */

export const MIN_EASE = 1.3
export const MAX_EASE = 2.5
const DEFAULT_EASE = 2.5
const EASE_DELTA_ON_SUCCESS = 0.1
const EASE_DELTA_ON_FAIL = 0.2
const FAIL_INTERVAL_DAYS = 1
const FIRST_SUCCESS_INTERVAL_DAYS = 1

/** 1本の定石ライン(`JosekiLine.id`)についてのSRS状態。 */
export interface JosekiSrsState {
  /** `JosekiLine.id` と一致するライン識別子。 */
  readonly lineId: string
  /** ease factor(1.3〜2.5にクランプ)。大きいほど間隔が伸びやすい。 */
  readonly ease: number
  /** 次回出題までの間隔(日数)。0はまだ一度も出題成功していないことを表す。 */
  readonly interval: number
  /** 連続正解数。失敗すると0にリセットされる。 */
  readonly streak: number
  /** 累計失敗回数。 */
  readonly fails: number
  /** 次回出題日(`YYYY-MM-DD`、ローカル日付基準)。 */
  readonly dueDate: string
  /** 直近の復習日時(ISO文字列)。未挑戦なら `null`。 */
  readonly lastReviewedAt: string | null
}

function clampEase(value: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, value))
}

/** `Date` を `YYYY-MM-DD` 形式のローカル日付キーに変換する。 */
export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

/** まだ一度も出題されていないラインの初期SRS状態(即座に出題対象になる)。 */
export function createInitialSrsState(lineId: string, now: Date = new Date()): JosekiSrsState {
  return {
    lineId,
    ease: DEFAULT_EASE,
    interval: 0,
    streak: 0,
    fails: 0,
    dueDate: toDateKey(now),
    lastReviewedAt: null,
  }
}

/**
 * クリア(正解)を記録した後のSRS状態を返す。
 * ease factorを少し上げ、`interval` を `ease` 倍(初回成功時は1日)に伸ばし、
 * 次回出題日をその分だけ先に進める。
 */
function applySuccess(prev: JosekiSrsState, now: Date): JosekiSrsState {
  const ease = clampEase(prev.ease + EASE_DELTA_ON_SUCCESS)
  const interval =
    prev.interval <= 0 ? FIRST_SUCCESS_INTERVAL_DAYS : Math.round(prev.interval * ease)
  return {
    lineId: prev.lineId,
    ease,
    interval,
    streak: prev.streak + 1,
    fails: prev.fails,
    dueDate: toDateKey(addDays(now, interval)),
    lastReviewedAt: now.toISOString(),
  }
}

/**
 * ゲームオーバー(失敗)を記録した後のSRS状態を返す。
 * ease factorを少し下げ、`interval` を1日にリセットして近い将来に
 * 再出題されるようにする。連続正解数(`streak`)は0に戻す。
 */
function applyFailure(prev: JosekiSrsState, now: Date): JosekiSrsState {
  const ease = clampEase(prev.ease - EASE_DELTA_ON_FAIL)
  return {
    lineId: prev.lineId,
    ease,
    interval: FAIL_INTERVAL_DAYS,
    streak: 0,
    fails: prev.fails + 1,
    dueDate: toDateKey(addDays(now, FAIL_INTERVAL_DAYS)),
    lastReviewedAt: now.toISOString(),
  }
}

/**
 * `lineId` の出題結果(`success`=クリア到達 / `fail`=ゲームオーバー)を
 * 反映した次のSRS状態を返す。`prev` が `null`(まだ一度も記録が無い)場合は
 * `createInitialSrsState` から開始する。
 */
export function nextSrsState(
  prev: JosekiSrsState | null,
  lineId: string,
  result: 'success' | 'fail',
  now: Date = new Date(),
): JosekiSrsState {
  const base = prev ?? createInitialSrsState(lineId, now)
  return result === 'success' ? applySuccess(base, now) : applyFailure(base, now)
}

/**
 * `state` が「本日出題すべき」かどうかを判定する。
 * 未挑戦(`state` が `undefined`/`null`)は常に出題対象。
 * それ以外は `dueDate` が `now` の日付以前であれば出題対象。
 */
export function isDue(state: JosekiSrsState | null | undefined, now: Date = new Date()): boolean {
  if (!state) return true
  return state.dueDate <= toDateKey(now)
}
