/**
 * 悪手判定・評価表示の共通型定義(T019)。
 *
 * どのモード(対局・定石練習・中盤練習・詰めオセロ・棋譜解析)からも
 * 再利用する想定の基盤型。参照: tasks/T019-eval-badge-blunder.md
 */

/**
 * 評価値の出典。`EvalBadge` の色分けに使う。
 * - `'joseki'`: 現局面が定石DB(`JosekiDb`)に登録されており、まだ定石が続いている
 *   (`isLeaf` でない)ノードである。
 * - `'exact'`: 定石を外れており、かつエンジンの評価が終盤完全読み
 *   (`MoveEvalJson.type === 'exact'`)によるもの。
 * - `'midgame'`: 定石を外れており、かつエンジンの評価が中盤探索
 *   (`MoveEvalJson.type === 'midgame'`)によるもの。
 */
export type EvalSource = 'joseki' | 'exact' | 'midgame'

/**
 * 悪手判定方式(ユーザー要望の3方式)。
 * - `'worseThanBest'`: 打った手が全合法手中の最善手でなければ悪手 ((a))
 * - `'lossThreshold'`: 打った手の評価値が最善手より `lossThreshold` 石以上低ければ悪手 ((b))
 * - `'rankThreshold'`: 打った手の順位が `rankThreshold` 位より下なら悪手 ((c))
 */
export type BlunderMethod = 'worseThanBest' | 'lossThreshold' | 'rankThreshold'

/** 悪手判定の設定。`BlunderSettings` でユーザーが調整し、`localStorage` に保存する。 */
export interface BlunderConfig {
  readonly method: BlunderMethod
  /** `method === 'lossThreshold'` のときに使う閾値(石差、0以上)。 */
  readonly lossThreshold: number
  /** `method === 'rankThreshold'` のときに使う閾値(順位、1以上)。 */
  readonly rankThreshold: number
}

/** `BlunderConfig` の既定値(「差分1.0石以上」を悪手とする)。 */
export const DEFAULT_BLUNDER_CONFIG: BlunderConfig = {
  method: 'lossThreshold',
  lossThreshold: 1.0,
  rankThreshold: 3,
}

/** `isBlunder` の判定結果。 */
export interface BlunderJudgement {
  readonly blunder: boolean
  /** 最善手からの評価値ロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** 打った手の順位(1始まり。同点は同順位として扱う)。 */
  readonly rank: number
  /** 最善手の記法("a1"〜"h8")。 */
  readonly bestMove: string
}
