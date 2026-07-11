/**
 * T058(悪手分析パネルの盤面連動レイアウト再設計)で`BlunderPanel.tsx`向けに
 * 実装された、評価内訳(`AttributionTerm`)/「なぜ悪いか」(`WhyBadReason`)の
 * 各項目に対応する盤面ハイライトマス集合を求める純粋関数群。
 *
 * T072(中盤練習モードの失敗時説明UI拡張)で`BlunderPanel.tsx`本体から本モジュールへ
 * 切り出した。どちらの関数も`MoveAnalysis`等の棋譜解析固有の型には依存しておらず、
 * 盤面・手番・マス番号・(必要なら)`BoardHighlights`のみから計算できる純粋関数
 * だったため、`PracticeMode.tsx`(中盤練習モード)からも同じロジックをそのまま
 * 再利用できるよう、両モジュールが共通してimportできる場所に移した(ロジックの
 * 複製を避けるため。CLAUDE.mdの教訓「複製すると将来のdriftリスクになる」に従う)。
 * 挙動は移動前と一切変更していない。
 */

import { legalMoves, opposite, type Board, type Side } from '../game/othello.ts'
import type { BoardHighlights } from './motifs.ts'
import type { AttributionTerm } from './types.ts'
import { computeStableSquares, type WhyBadReason } from './whyBad.ts'

/** 4隅のマス番号。「隅」項目のホバーハイライトに使う。 */
export const CORNER_SQUARES: readonly number[] = [0, 7, 56, 63]

/**
 * 評価内訳(モビリティ/隅/確定石)の項目に対応する、着手前局面上のマス集合を
 * 返す(T058要件1)。評価内訳自体は比較PVの末端局面同士の差分だが、盤面
 * ハイライトは既に画面上部に表示済みの「着手前局面」を使い、その局面上で
 * 各項目に関連する特徴(モビリティ=双方の合法手、隅=4隅、確定石=着手前局面の
 * 確定石)を示す近似とする(実装者判断。比較PVの末端局面2つを新たに描画する
 * よりも、既存の1枚の盤面との連動で示す方が実装・表示ともに単純なため)。
 */
export function attributionTermHighlightSquares(
  key: AttributionTerm['key'],
  beforeBoard: Board,
  side: Side,
  boardHighlights: BoardHighlights | null,
): number[] {
  switch (key) {
    case 'stable':
      return boardHighlights ? [...boardHighlights.stable] : []
    case 'corner':
      return [...CORNER_SQUARES]
    case 'mobility':
      return [...legalMoves(beforeBoard, side), ...legalMoves(beforeBoard, opposite(side))]
  }
}

/**
 * 「なぜ悪いか」の理由(`WhyBadReason.category`)に対応する、着手前局面上の
 * マス集合を返す(T058要件1)。`attributionTermHighlightSquares`と同じ考え方
 * (モビリティ=双方の合法手、確定石=着手前局面の確定石)を使うが、隅の危険
 * (X打ち/C打ち)は「なぜ悪いか」では実際に検出された1件の着手先と対応する
 * 隅のみを指すため、`boardHighlights.dangerousCorners`(盤面全体の候補一覧)
 * ではなく`cornerRisk`から直接2マスを算出する。
 */
export function whyBadReasonHighlightSquares(
  category: WhyBadReason['category'],
  beforeBoard: Board,
  side: Side,
  cornerRiskSquare: number | null,
  moveSquare: number,
): number[] {
  switch (category) {
    case 'stable':
      return [...computeStableSquares(beforeBoard, side)]
    case 'mobility':
      return [...legalMoves(beforeBoard, side), ...legalMoves(beforeBoard, opposite(side))]
    case 'corner':
      return cornerRiskSquare === null ? [moveSquare] : [moveSquare, cornerRiskSquare]
    case null:
      return []
  }
}
