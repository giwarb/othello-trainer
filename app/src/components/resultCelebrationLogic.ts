/**
 * 対局モード(`PlayMode`)終局時の勝敗演出(T067)の種別判定ロジック(純粋関数)。
 *
 * `ResultCelebration.tsx`本体から分離してあるのは、他の`*Logic.ts`
 * (`moveEvalOverlayLogic.ts`等)と同じ理由: このリポジトリの単体テスト
 * (`vitest.config.ts`)は`src/**\/*.test.ts`(拡張子`.tsx`は対象外)のみを
 * 対象にしており、コンポーネント本体を直接テストする仕組みが無いため。
 * 「対局結果と人間側の色から演出種別を決める」判定部分だけをここに切り出す。
 */

import type { GameResult } from '../game/gameLoop.ts'
import type { Side } from '../game/othello.ts'

/** 勝敗演出の種別。'win'=人間の勝ち、'lose'=人間の負け、'draw'=引き分け。 */
export type CelebrationKind = 'win' | 'lose' | 'draw'

/**
 * 対局結果(`GameResult`)と人間が担当していた色(`humanSide`)から、
 * 表示すべき演出種別を判定する。
 *
 * - 引き分け(`result === 'draw'`)は常に`'draw'`。
 * - 勝った側(`result`)が人間側の色と一致すれば`'win'`、一致しなければ
 *   (CPU側の色が勝った)`'lose'`。
 */
export function celebrationKindFor(result: GameResult, humanSide: Side): CelebrationKind {
  if (result === 'draw') return 'draw'
  return result === humanSide ? 'win' : 'lose'
}
