/**
 * 詰めオセロ問題の手筋タグ(設計書§5.1)の簡易判定。
 *
 * 「偶数理論」「手止まり」「連打」は機械的な判定が難しいため本タスクでは
 * 実装しない(タスク仕様「本タスクでのスコープ縮小」参照、`types.ts` の
 * `PuzzleTag` コメントも参照)。ここでは、`engine/src/bin/puzzlegen.rs` の
 * `evaluate` サブコマンドが既に計算済みの「事実」(隅隣接マスかつ対応する
 * 隅が空いているか / 確定石数が増えたか)を受け取り、タグの配列に変換する
 * だけの薄い純粋関数にしてある(盤面ロジック自体の再実装はしない)。
 */

import type { PuzzleTag } from './types.ts'

export interface MoveFacts {
  /** 正解手が、対応する隅がまだ空いている隅隣接マス(X打ち/C打ち)であるか。 */
  readonly cornerSacrificeCandidate: boolean
  /** 正解手を打った後、着手側の確定石数(簡易判定)が着手前より増えたか。 */
  readonly stableGain: boolean
}

/** `facts` から手筋タグの配列を導出する(該当なしなら空配列)。 */
export function deriveTags(facts: MoveFacts): PuzzleTag[] {
  const tags: PuzzleTag[] = []
  if (facts.cornerSacrificeCandidate) tags.push('corner-sacrifice')
  if (facts.stableGain) tags.push('stable-gain')
  return tags
}

/**
 * 複数の正解手(唯一解性フィルタで1〜2手まで許容)がある場合、いずれか1つでも
 * 事実を満たせばそのタグを付与する(問題全体として「そのタグに該当する解法が
 * 存在する」ことを示すため)。
 */
export function deriveTagsFromMultiple(factsList: readonly MoveFacts[]): PuzzleTag[] {
  const merged: MoveFacts = {
    cornerSacrificeCandidate: factsList.some((f) => f.cornerSacrificeCandidate),
    stableGain: factsList.some((f) => f.stableGain),
  }
  return deriveTags(merged)
}
