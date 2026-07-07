/**
 * 中盤練習モード(T021)の共通型定義。
 *
 * 設計書 `othello-trainer-design.md` §4「中盤練習モード」のうち、本タスクの
 * スコープ(タスク仕様「本タスクでのスコープ縮小」参照)に合わせた型を定義する。
 */

import type { Side } from '../game/othello.ts'

/**
 * 判定モード(要件1・4)。
 * - `'strict'`: 厳格。打った手が最善手(ロス0)でなければ失敗。
 * - `'standard'`: 標準(既定)。石差ロスが `judgeMidgameMove.ts` の
 *   `STANDARD_LOSS_THRESHOLD` 以下なら正解。
 * - `'noReversal'`: 逆転禁止。評価の符号(優勢/劣勢)が入れ替わったら失敗。
 */
export type JudgeMode = 'strict' | 'standard' | 'noReversal'

/**
 * 相手(エンジン)の強さ(要件1・5)。
 * 「実戦模倣(WTHOR頻度分布)」はWTHORデータが未導入のため本タスクではスコープ外
 * (タスク仕様「本タスクでのスコープ縮小」参照)。
 */
export type OpponentStrength = 'best' | 'top3Random'

/**
 * 開始局面の生成元(要件1・2)。
 * - `'josekiEnd'`: 定石DBの終端(`isLeaf`)局面からランダムに1つ選ぶ。
 * - `'selfPlayRandom'`: エンジン自己対局によるランダム中盤局面(WTHOR由来の
 *   ランダム実戦局面の代替)。
 * 「自分の棋譜解析で悪手を打った局面」は棋譜解析モード未実装のためスコープ外。
 */
export type StartPositionSource = 'josekiEnd' | 'selfPlayRandom'

/**
 * IndexedDBに保存する盤面のシリアライズ形式。
 * bigintはIndexedDBの構造化複製でもそのまま保存できるが、`engine/client.ts`が
 * 既に採用している「16進文字列化」のパターン(`engine/hex.ts`)に統一し、
 * 将来のエクスポート/インポート(JSON化)や、構造化複製のbigint対応状況に
 * ブラウザ差異があるリスクを避ける。
 */
export interface SerializedBoard {
  readonly black: string
  readonly white: string
}

/**
 * 出題プール(失敗した開始局面の自動収集)の1レコード(要件7)。
 *
 * `source` は本タスクでは実質的に常に `'blunder-review'`(判定モードでの失敗、
 * または終盤の評価逆転・優勢維持失敗による失敗)を使う。棋譜解析モード
 * (design §6、未実装)実装時に別の `source` 値でレコードを追加できるよう、
 * 型としては汎用的な `string` にしておく(タスク仕様「やらないこと」参照)。
 */
export interface MidgamePoolEntry {
  readonly id: string
  readonly board: SerializedBoard
  readonly turn: Side
  readonly source: string
  readonly createdAt: string
}
