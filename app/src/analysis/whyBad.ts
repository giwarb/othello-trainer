/**
 * 悪手分析パネル(T030、要件3・設計書§6.4)の「なぜ悪いか」ヒューリスティック表示。
 *
 * タスク仕様「本タスクでのスコープ縮小」に従い、機械的に判定しやすい3種類のみを
 * 実装する: 着手可能数差の推移・確定石数の変化(簡易判定)・X打ち/C打ちの検出。
 * 「偶数理論違反」は判定ロジックが複雑なため実装しない(スコープ外)。
 *
 * 純粋関数のみで構成する(盤面2つと着手だけから計算でき、エンジン呼び出しは
 * 不要。副作用なし)。
 */

import { applyMove, cellAt, legalMoves, opposite, squareToNotation, type Board, type Side } from '../game/othello.ts'

// --- 着手可能数 ---------------------------------------------------------

export interface WhyBadMobility {
  /** 着手前局面で、手を打つ側が持っていた合法手の数。 */
  readonly moverMobilityBefore: number
  /** 着手前局面で、相手が持っていた合法手の数。 */
  readonly opponentMobilityBefore: number
  /** 着手後局面で、相手が持つことになった合法手の数。 */
  readonly opponentMobilityAfter: number
  /** 着手後局面で、手を打った側が(次に手番が回ってきたときに)持つ合法手の数。 */
  readonly moverMobilityAfter: number
  /** この手によって相手の着手可能数が、手を打つ前の自分の着手可能数を上回ったか(悪化の兆候)。 */
  readonly opponentGainedMobility: boolean
}

function computeMobility(beforeBoard: Board, side: Side, afterBoard: Board): WhyBadMobility {
  const opponent = opposite(side)
  const moverMobilityBefore = legalMoves(beforeBoard, side).length
  const opponentMobilityBefore = legalMoves(beforeBoard, opponent).length
  const opponentMobilityAfter = legalMoves(afterBoard, opponent).length
  const moverMobilityAfter = legalMoves(afterBoard, side).length
  return {
    moverMobilityBefore,
    opponentMobilityBefore,
    opponentMobilityAfter,
    moverMobilityAfter,
    opponentGainedMobility: opponentMobilityAfter > moverMobilityBefore,
  }
}

// --- 確定石数 -------------------------------------------------------------

/** 4辺それぞれの8マス(端から端への順)。`engine/src/eval.rs`のTOP_EDGE等と同じ定義・順序。 */
const EDGES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7], // 水平: a1..h1
  [56, 57, 58, 59, 60, 61, 62, 63], // 水平: a8..h8
  [0, 8, 16, 24, 32, 40, 48, 56], // 垂直: a1..a8
  [7, 15, 23, 31, 39, 47, 55, 63], // 垂直: h1..h8
]

/**
 * 1つの辺(端から端までの8マス)について、両端から連続する同色石のマス集合を返す。
 * `engine/src/eval.rs`の`edge_stable_mask`と全く同じロジック(前端から同色が
 * 途切れるまで・後端から同色が途切れるまでをそれぞれ数え、和集合を取る)。
 */
function edgeStableSquares(board: Board, side: Side, edge: readonly number[]): number[] {
  const result: number[] = []

  for (const sq of edge) {
    if (cellAt(board, sq) === side) result.push(sq)
    else break
  }

  for (let i = edge.length - 1; i >= 0; i--) {
    const sq = edge[i]!
    if (cellAt(board, sq) === side) result.push(sq)
    else break
  }

  return result
}

/**
 * `side`の確定石(絶対にひっくり返らない石)のマス集合を簡易判定で求める。
 *
 * 【T058で統一】以前はTS側独自の4軸固定点反復アルゴリズム(隅から安定集合を
 * 広げる、より多くの確定石を検出しうる方式)を使っており、`engine/src/eval.rs`
 * の`stable_mask`(隅を起点として辺方向へ連続する同色石のみを確定石とみなす、
 * より保守的な簡易ロジック)とは別実装だった。この2つは同じ局面に対して
 * 異なる個数を返しうるため、悪手分析パネルの「なぜ悪いか」(本関数由来)と
 * 「評価内訳分解」(`attribution.ts`、`eval::stable_count`由来)とで確定石数の
 * 表示値が食い違う可能性があった(T031やり直し1回目でこの問題を認識したが、
 * `eval::evaluate`が実際に使っている値との厳密一致を優先し、当時は統一を
 * 見送っていた)。
 *
 * T058(盤面連動レイアウト再設計)で、評価内訳と「なぜ悪いか」を同じ盤面上で
 * 同時に見せる設計にしたため、この食い違いがユーザーに露呈しやすくなる。
 * そこで本関数を`eval::eval.rs`の`stable_mask`/`edge_stable_mask`と全く同じ
 * アルゴリズム(4辺それぞれについて、両端から連続する同色石を数えて和集合を
 * 取るだけ。斜め方向・「ラインが空きマス無しで埋まっている」場合の特例は
 * 持たない)に置き換えた。これにより、TS側(本関数、盤面オーバーレイ・
 * 「なぜ悪いか」表示に使用)とRust側(`eval::stable_count`、評価内訳分解に
 * 使用)は同一のロジックを実装することになり、同じ局面に対する確定石数は
 * 常に一致する(2つの独立した実装ではあるが、アルゴリズムそのものを完全に
 * 揃えたことで数値の食い違いは起こりえない)。この変更に伴い、盤面が
 * 完全に埋まった局面での確定石数(旧アルゴリズムでは全石が確定石扱いだった)
 * 等、一部の局面で戻り値が変わる(`whyBad.test.ts`参照)。
 */
export function computeStableSquares(board: Board, side: Side): Set<number> {
  const stable = new Set<number>()
  for (const edge of EDGES) {
    for (const sq of edgeStableSquares(board, side, edge)) stable.add(sq)
  }
  return stable
}

export function countStableDiscs(board: Board, side: Side): number {
  return computeStableSquares(board, side).size
}

export interface WhyBadStability {
  readonly moverStableBefore: number
  readonly moverStableAfter: number
  /** `moverStableAfter - moverStableBefore`。 */
  readonly delta: number
}

function computeStability(beforeBoard: Board, side: Side, afterBoard: Board): WhyBadStability {
  const moverStableBefore = countStableDiscs(beforeBoard, side)
  const moverStableAfter = countStableDiscs(afterBoard, side)
  return { moverStableBefore, moverStableAfter, delta: moverStableAfter - moverStableBefore }
}

// --- X打ち/C打ち検出 -----------------------------------------------------

/** X打ちマス(隅の斜め隣)-> 対応する隅マス番号。 */
const X_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [9, 0], // b2 -> a1
  [14, 7], // g2 -> h1
  [49, 56], // b7 -> a8
  [54, 63], // g7 -> h8
])

/** C打ちマス(隅の直交隣、辺上)-> 対応する隅マス番号。 */
const C_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [1, 0], // b1 -> a1
  [8, 0], // a2 -> a1
  [6, 7], // g1 -> h1
  [15, 7], // h2 -> h1
  [57, 56], // b8 -> a8
  [48, 56], // a7 -> a8
  [62, 63], // g8 -> h8
  [55, 63], // h7 -> h8
])

export interface WhyBadCornerRisk {
  readonly kind: 'x' | 'c'
  /** 対応する隅マスの記法("a1"等)。まだ空いていることが検出の条件。 */
  readonly corner: string
}

/**
 * `square`(着手前局面での着手先)がX打ち/C打ちに該当し、かつ対応する隅が
 * まだ空いているかを判定する。該当しなければ`null`。
 */
function detectCornerRisk(beforeBoard: Board, square: number): WhyBadCornerRisk | null {
  const xCorner = X_SQUARE_TO_CORNER.get(square)
  if (xCorner !== undefined && cellAt(beforeBoard, xCorner) === null) {
    return { kind: 'x', corner: squareToNotation(xCorner) }
  }
  const cCorner = C_SQUARE_TO_CORNER.get(square)
  if (cCorner !== undefined && cellAt(beforeBoard, cCorner) === null) {
    return { kind: 'c', corner: squareToNotation(cCorner) }
  }
  return null
}

// --- まとめ ---------------------------------------------------------------

/**
 * 表示用に整形済みの理由テキスト1件ぶん。`category`はT058(盤面連動レイアウト
 * 再設計)で追加した、この理由に対応する盤面ハイライトの種別
 * (`BlunderPanel.tsx`が`category`に応じてホバー時のハイライトマスを決める。
 * `motifs.ts`の`BoardHighlights`のキーとは独立の、この3種のみの簡易分類)。
 * 対応する具体的なマスが無い理由(該当なし)では`null`。
 */
export interface WhyBadReason {
  readonly text: string
  readonly category: 'mobility' | 'stable' | 'corner' | null
}

export interface WhyBadResult {
  readonly mobility: WhyBadMobility
  readonly stability: WhyBadStability
  readonly cornerRisk: WhyBadCornerRisk | null
  /** 表示用に整形済みの理由(1件1項目)。 */
  readonly reasons: readonly WhyBadReason[]
}

/**
 * 悪手局面(`beforeBoard`、`side`が手番)で`square`に着手した理由を分析する。
 * `square`は`legalMoves(beforeBoard, side)`に含まれる合法手であることを前提とする。
 */
export function analyzeWhyBad(beforeBoard: Board, side: Side, square: number): WhyBadResult {
  const afterBoard = applyMove(beforeBoard, side, square)
  const mobility = computeMobility(beforeBoard, side, afterBoard)
  const stability = computeStability(beforeBoard, side, afterBoard)
  const cornerRisk = detectCornerRisk(beforeBoard, square)

  const reasons: WhyBadReason[] = []
  reasons.push({
    text:
      `着手可能数: この手の前はあなたが${mobility.moverMobilityBefore}箇所に打てましたが、` +
      `この手の後は相手が${mobility.opponentMobilityAfter}箇所に打てるようになりました。`,
    category: 'mobility',
  })
  if (mobility.opponentGainedMobility) {
    reasons.push({ text: 'この手により相手の選択肢が広がりました(着手可能数の悪化)。', category: 'mobility' })
  }
  reasons.push({
    text:
      `確定石数: ${stability.moverStableBefore}個 → ${stability.moverStableAfter}個` +
      `(${stability.delta >= 0 ? '+' : ''}${stability.delta})`,
    category: 'stable',
  })
  if (cornerRisk) {
    reasons.push({
      text:
        `${cornerRisk.kind === 'x' ? 'X打ち' : 'C打ち'}: 隅${cornerRisk.corner}がまだ空いている状態で、` +
        `その隅に隣接するマスへ着手しています。`,
      category: 'corner',
    })
  }

  return { mobility, stability, cornerRisk, reasons }
}
