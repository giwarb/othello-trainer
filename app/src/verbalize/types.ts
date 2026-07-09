/**
 * T035「言語化トレーニングモード」(`othello-trainer-design-verbalization.md` §6)の
 * 共通型定義。
 *
 * 出題フロー(設計書§6.1): 局面提示(評価値非表示)→ 着手 → 理由タグ選択(1〜3個)
 * +自由記述 → 検証(手の正誤×理由の正誤の2×2判定)。
 *
 * # 出典についてのスコープ縮小(タスク仕様「本タスクでのスコープ縮小」参照)
 *
 * 設計書§6.1は出典として「中盤練習プール・自分の悪手局面・名局」の3種を挙げるが、
 * 「名局」データベースは本プロジェクトに存在しないため実装しない。
 *
 * さらに、「中盤練習プール」と「自分の悪手局面」は、現行実装では両方とも同一の
 * IndexedDBストア(`midgame/pool.ts`の`midgamePool`)に格納されている
 * (`midgame/PracticeMode.tsx`の判定失敗時の自動登録(`registerFailure`)も、
 * `analysis/sendToPractice.ts`の`sendToMidgamePractice`(棋譜解析で検出した悪手を
 * 「中盤練習に送る」ボタンから登録する経路)も、どちらも同じストアに
 * `source: 'blunder-review'`として書き込む設計になっている)。本タスクで新たに
 * 「棋譜解析で検出した悪手」専用の別ストアを作ると、`midgamePool`と実質的に重複する
 * データ管理になり、`CLAUDE.md`の「IndexedDBは`appDb.ts`で一元管理する」という方針の
 * 精神(同じ種類のデータを複数箇所で別々に管理しない)にも反するリスクがある。
 * そのため本タスクでは`ProblemSource`を
 * - `'pool'`(プール全件。設計書の「中盤練習プール」に相当)
 * - `'myBlunder'`(`source === 'blunder-review'`のものに絞り込み。設計書の
 *   「自分の悪手局面」に相当)
 * の2種として実装する(`verbalize/pickProblem.ts`参照)。現状のデータでは両者は
 * ほぼ同じ集合になるが、将来`midgamePool`に別の`source`値が追加された場合に
 * 意味のある区別になる設計とした。
 */

import type { Board, Side } from '../game/othello.ts'

/** 出題の出典(上記コメント参照)。 */
export type ProblemSource = 'pool' | 'myBlunder'

/** 1問ぶんの出題データ。 */
export interface VerbalizeProblem {
  readonly id: string
  readonly board: Board
  readonly sideToMove: Side
  readonly source: ProblemSource
  /** 局面の一意なキー(`joseki/normalize.ts`の`hashBoard`)。自由記述の同一局面判定に使う。 */
  readonly positionKey: string
}

/**
 * 2×2判定のケース(設計書§6.1手順4、要件4)。
 * - `'correctBoth'`: 手○理由○。完全正解。
 * - `'correctMoveWrongReason'`: 手○理由×。「正解だが理由が違う」— 最重要のフィードバック
 *   (まぐれ当たりを検出できるのはタグ宣言があるからこそ)。
 * - `'wrongMoveCorrectReason'`: 手×理由○。着眼は正しい。同じ局面で手だけ選び直す。
 * - `'wrongBoth'`: 手×理由×。概念レッスンへ誘導(本タスクでは簡易説明文を表示)。
 */
export type VerbalizeCaseKind =
  | 'correctBoth'
  | 'correctMoveWrongReason'
  | 'wrongMoveCorrectReason'
  | 'wrongBoth'

/** IndexedDB(`verbalizeAttempts`ストア)に保存する1回の挑戦記録(要件6)。 */
export interface VerbalizeAttemptRecord {
  readonly id: string
  /** `VerbalizeProblem.positionKey`。同じ局面への再挑戦の突き合わせに使う。 */
  readonly positionKey: string
  readonly sideToMove: Side
  /** プレイヤーが選んだ手の記法("a1"〜"h8")。 */
  readonly chosenMove: string
  /** プレイヤーが選んだ理由タグID(1〜3個、`reasonTags.ts`の`ReasonTag.id`)。 */
  readonly chosenTags: readonly string[]
  /** 自由記述メモ(空文字列も許容する)。 */
  readonly freeText: string
  readonly caseKind: VerbalizeCaseKind
  readonly createdAt: string
}
