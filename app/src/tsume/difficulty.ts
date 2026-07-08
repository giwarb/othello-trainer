/**
 * 詰めオセロ問題生成パイプライン(T027)の難易度スコアリング。
 *
 * 設計書§5.2: 「難易度スコア = f(空き数, 勝ち手の探索順位, 罠手の魅力度)」。
 * 3つのパラメータをそれぞれ以下のように定義する(いずれもRustの
 * `engine/src/bin/puzzlegen.rs evaluate` が出す生データから
 * `puzzlegen/generate.ts` が算出する):
 *
 * - `empties`(空き数): そのまま。空きが多いほど終局まで読む手数が増え、
 *   一般に難しくなるため線形に加算する。
 * - `apparentRank`(見かけの順位): 全合法手を「着手直後の静的評価
 *   (`eval::evaluate_for`、深さ0、探索を一切行わない一番浅い評価)」の
 *   降順に並べたときの、正解手(複数ある場合はその中で最も順位が良いもの)の
 *   1始まりの順位。1なら「浅い評価でもすぐ正解に見える」= 易しい。
 *   大きいほど「浅い評価では正解が良く見えない」= 気づきにくい = 難しい。
 * - `trapScore`(罠手の魅力度): 正解手以外(不正解)の手の中で、浅い評価が
 *   最も高いものと、正解手(`apparentRank`の算出に使ったのと同じ、最も
 *   順位が良い正解手)の浅い評価との差(centi-disc単位)。正なら「不正解の
 *   手の方が浅い評価では正解より良く見える」= 罠として機能している。
 *   0以下(正解手が既に最も良く見えている)なら罠は無いとみなし0とする。
 *
 * 3項の重みは以下の考え方で決めた(実測データでの回帰等は行っていない、
 * 実装者判断のヒューリスティックであることに注意。タスク仕様が「具体的な
 * スコア式は実装者が設計してよい」としているためこの方針を採用した):
 * - `empties`は6〜20の範囲でそのまま加算(重み1)。
 * - `apparentRank`は合法手数がだいたい5〜10程度であることが多く、
 *   1ランク違うことの体感難易度への影響は空き1マス分より大きいと考え、
 *   重み3を掛ける(例: 順位が1→4に上がると、空き9マス分に相当する加算)。
 * - `trapScore`はcenti-disc単位(1石=100)で数百〜数千の値になりうるため、
 *   まず/100して石差相当の単位に直した上で、重み2を掛ける(石差1相当の
 *   罠の魅力度が、空き2マス分の難易度に相当する、という重み付け)。
 *
 * これらの重みで単調性(各パラメータを増やすとスコアが単調非減少)は
 * 自明に保たれる(全項が非負係数の線形結合のため)。`difficulty.test.ts`で
 * 単調性を回帰的に確認する。
 */

import type { DifficultyLevel } from './types.ts'

const EMPTIES_WEIGHT = 1
const RANK_WEIGHT = 3
/** `trapScore`(centi-disc)を石差相当に直してから掛ける重み。 */
const TRAP_WEIGHT = 2 / 100

export interface DifficultyInputs {
  /** 出題局面の空きマス数。 */
  readonly empties: number
  /** 浅い評価による正解手の見かけの順位(1始まり)。 */
  readonly apparentRank: number
  /** 罠手の魅力度(centi-disc単位、0以上)。 */
  readonly trapScore: number
}

/**
 * 難易度の生スコア(値そのものに絶対的な意味は無く、他の問題との相対比較
 * ―特に `bucketDifficultyThresholds` によるパーセンタイル分割―にのみ使う)。
 */
export function difficultyRawScore({ empties, apparentRank, trapScore }: DifficultyInputs): number {
  const rankPenalty = Math.max(0, apparentRank - 1)
  const trapPenalty = Math.max(0, trapScore)
  return empties * EMPTIES_WEIGHT + rankPenalty * RANK_WEIGHT + trapPenalty * TRAP_WEIGHT
}

/** 生成された問題プール全体の難易度が5段階にほぼ均等に分かれるよう、パーセンタイル境界を求める。 */
export function bucketDifficultyThresholds(scores: readonly number[], levels = 5): number[] {
  if (scores.length === 0) return []
  const sorted = [...scores].sort((a, b) => a - b)
  const thresholds: number[] = []
  for (let level = 1; level < levels; level++) {
    const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * level) / levels))
    thresholds.push(sorted[idx]!)
  }
  return thresholds
}

/**
 * `thresholds`(`bucketDifficultyThresholds` が返す、昇順の`levels-1`個の境界値)を
 * 使って、1つのスコアを1〜5の難易度レベルに変換する。
 */
export function levelForScore(score: number, thresholds: readonly number[]): DifficultyLevel {
  let level = 1
  for (const t of thresholds) {
    if (score > t) level++
  }
  return Math.min(5, level) as DifficultyLevel
}
