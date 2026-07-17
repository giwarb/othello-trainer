import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createBoard,
  initialBoard,
  notationToSquare,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import type { FeatureSet } from '../analysis/types.ts'
import {
  CORNER_GIFT_SEVERITY,
  OPPONENT_MOBILITY_THRESHOLD,
  STABLE_LOSS_THRESHOLD,
  WALL_FRONTIER_THRESHOLD,
  X_C_DANGER_SEVERITY,
  detectClearBlunderPatterns,
  detectCornerGift,
  detectOpponentMobility,
  detectStableLoss,
  detectWallFrontier,
  detectXCDanger,
  type ClearBlunderInput,
} from './clearBlunder.ts'

/**
 * テスト用にひとまず「無害」な既定値を持つ`FeatureSet`を作る
 * (`analysis/motifs.test.ts`の`baseFeatures`と同じ方針)。各テストで
 * 検出条件に関わる部分だけ`overrides`で上書きする。
 */
function baseFeatures(overrides: Partial<FeatureSet> = {}): FeatureSet {
  return {
    mobilityDiff: 0,
    moverMobilityBefore: 4,
    opponentMobilityBefore: 4,
    opponentMobilityAfter: 4,
    moverMobilityAfter: 4,
    potentialMobilityDiff: 0,
    openness: 1,
    isUchiwari: true,
    frontierDiff: 0,
    newOpponentMoves: [],
    lostOwnMoves: [],
    stableDiff: 0,
    edgeShapes: [
      { edge: 'top', shape: 'open', emptyCount: 4 },
      { edge: 'bottom', shape: 'open', emptyCount: 4 },
      { edge: 'left', shape: 'open', emptyCount: 4 },
      { edge: 'right', shape: 'open', emptyCount: 4 },
    ],
    cornerRisk: null,
    parityRegions: [],
    seedStones: [],
    lines: [
      { name: 'main_diagonal', mover: 0, opponent: 0, empty: 8 },
      { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
    ],
    ...overrides,
  }
}

/** 初期局面から`moves`を交互に(黒から)適用した後の局面と手番を返す(テスト用局面構築ヘルパー)。 */
function boardAfterSequence(moves: readonly string[]): { board: Board; side: Side } {
  let board: Board = initialBoard()
  let side: Side = 'black'
  for (const mv of moves) {
    board = applyMove(board, side, notationToSquare(mv))
    side = opposite(side)
  }
  return { board, side }
}

function makeInput(overrides: Partial<ClearBlunderInput> & Pick<ClearBlunderInput, 'preMoveBoard' | 'preMoveSide'>): ClearBlunderInput {
  return {
    playedSquare: notationToSquare('d3'),
    bestSquare: notationToSquare('d3'),
    playedFeatures: baseFeatures(),
    bestFeatures: baseFeatures(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------
// opponent-mobility
// ---------------------------------------------------------------------

describe('clearBlunder: opponent-mobility(相手の合法手数の差)', () => {
  // 初期局面から12手(f5,f4,c3,c4,d3,f6,b3,d6,g4,c2,e2,h4)進めた局面。
  // 黒番で、候補手ごとに着手後の白の合法手数が5〜10と幅がある
  // (scratchpadで`game/othello.ts`を直接実行して事前に確認済み)。
  const { board, side } = boardAfterSequence(['f5', 'f4', 'c3', 'c4', 'd3', 'f6', 'b3', 'd6', 'g4', 'c2', 'e2', 'h4'])

  it('相手の合法手数の差が閾値以上なら検出する(g6: 白10か所 vs b1: 白5か所、差5)', () => {
    const input = makeInput({
      preMoveBoard: board,
      preMoveSide: side,
      playedSquare: notationToSquare('g6'),
      bestSquare: notationToSquare('b1'),
    })
    const result = detectOpponentMobility(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('opponent-mobility')
    expect(result?.message).toBe('この手の後、相手は10か所に打てます。最善手なら5か所でした。')
    expect(result?.severity).toBe(5)
    expect(result!.severity).toBeGreaterThanOrEqual(OPPONENT_MOBILITY_THRESHOLD)
  })

  it('相手の合法手数の差が閾値未満なら検出しない(c1: 白6か所 vs d1: 白6か所、差0)', () => {
    const input = makeInput({
      preMoveBoard: board,
      preMoveSide: side,
      playedSquare: notationToSquare('c1'),
      bestSquare: notationToSquare('d1'),
    })
    expect(detectOpponentMobility(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// corner-gift
// ---------------------------------------------------------------------

describe('clearBlunder: corner-gift(相手に隅を取られる/取られない)', () => {
  // 黒: c1, b3, f3 / 白: d1, b2, f4。黒の合法手は b1(b2を挟む) と f5(f4を挟む)。
  // b1に着手すると a1-b1-c1-d1 のラインが揃い、白がa1(隅)に着手できるようになる。
  // f5に着手しても隅には影響しない(scratchpadで事前確認済み)。
  const before = createBoard(
    [notationToSquare('c1'), notationToSquare('b3'), notationToSquare('f3')],
    [notationToSquare('d1'), notationToSquare('b2'), notationToSquare('f4')],
  )

  it('afterPlayedでは相手が隅に打てるようになり、afterBestでは打てないなら検出する', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b1'),
      bestSquare: notationToSquare('f5'),
    })
    const result = detectCornerGift(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('corner-gift')
    expect(result?.message).toBe('この手だと相手に隅(a1)を取られます。最善手なら取られませんでした。')
    expect(result?.severity).toBe(CORNER_GIFT_SEVERITY)
    expect(result?.playedHighlightSquares).toEqual([notationToSquare('a1')])
  })

  it('afterPlayedでも相手が隅に打てないなら検出しない(手を入れ替えたケース)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('b1'),
    })
    expect(detectCornerGift(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// x-c-danger
// ---------------------------------------------------------------------

describe('clearBlunder: x-c-danger(実際の手がX/C打ちで、最善手はそうでない)', () => {
  // 黒: c3 / 白: b3, a3。a1(隅)は空いたまま。b2は隅a1に対するX打ちマス
  // (`whyBad.test.ts`と同じ局面)。d4は隅とは無関係な安全なマス。
  const before = createBoard([notationToSquare('c3')], [notationToSquare('b3'), notationToSquare('a3')])

  it('実際の手がX打ちで最善手が安全な手なら検出する', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b2'),
      bestSquare: notationToSquare('d4'),
    })
    const result = detectXCDanger(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('x-c-danger')
    expect(result?.message).toBe('隅がまだ空いているのに、その斜め隣(X)に打つと隅を取られやすくなります。')
    expect(result?.severity).toBe(X_C_DANGER_SEVERITY)
    expect(result?.playedHighlightSquares).toEqual([notationToSquare('b2'), notationToSquare('a1')])
  })

  it('最善手も同種のX/C打ちなら検出しない(g2はh1に対するX打ち、h1も空いている)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b2'),
      bestSquare: notationToSquare('g2'),
    })
    expect(detectXCDanger(input)).toBeNull()
  })

  it('実際の手がX/C打ちでなければ検出しない', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('d4'),
      bestSquare: notationToSquare('e5'),
    })
    expect(detectXCDanger(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// wall-frontier
// ---------------------------------------------------------------------

describe('clearBlunder: wall-frontier(フロンティア石の増加差)', () => {
  // 黒: a4 + 隅付近の密集クラスタ(a1,c1,a3,c3,b3,a2,c2) / 白: b4-g4(横一列)+b1。
  // 黒の合法手はh4(白の横一列b4-g4を一気に挟んで反転、フロンティア急増)と
  // a5〜e5(密集クラスタ寄りの手、フロンティア増加は緩やか)。
  const before = createBoard(
    [
      notationToSquare('a4'),
      notationToSquare('a1'),
      notationToSquare('c1'),
      notationToSquare('a3'),
      notationToSquare('c3'),
      notationToSquare('b3'),
      notationToSquare('a2'),
      notationToSquare('c2'),
    ],
    [
      notationToSquare('b4'),
      notationToSquare('c4'),
      notationToSquare('d4'),
      notationToSquare('e4'),
      notationToSquare('f4'),
      notationToSquare('g4'),
      notationToSquare('b1'),
    ],
  )

  it('フロンティア石の増加差が閾値以上なら検出する(h4: 15個 vs a5: 10個、差5)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('h4'),
      bestSquare: notationToSquare('a5'),
    })
    const result = detectWallFrontier(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('wall-frontier')
    expect(result?.message).toBe('この手は自分の石を外側にさらします(壁)。相手から攻めやすい形です。')
    expect(result?.severity).toBe(5)
    expect(result!.severity).toBeGreaterThanOrEqual(WALL_FRONTIER_THRESHOLD)
  })

  it('フロンティア石の増加差が閾値未満なら検出しない(a5 vs b5、差0)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('a5'),
      bestSquare: notationToSquare('b5'),
    })
    expect(detectWallFrontier(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// stable-loss
// ---------------------------------------------------------------------

describe('clearBlunder: stable-loss(確定石の差)', () => {
  it('bestFeatures.stableDiffがplayedFeatures.stableDiffより閾値以上大きいなら検出する', () => {
    // 黒: d1, f3 / 白: b1, c1, f4。黒の合法手はa1(b1,c1を挟み、上辺左側
    // a1-b1-c1-d1が確定石化。確定石差+4)とf5(f4を挟むだけの内側の手、
    // 確定石差0)。ここでは「実際に打った手」がf5(悪い方)、
    // 「最善手」がa1(良い方)というシナリオにする(scratchpadで事前確認済み)。
    const before = createBoard(
      [notationToSquare('d1'), notationToSquare('f3')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('a1'),
      playedFeatures: baseFeatures({ stableDiff: 0 }),
      bestFeatures: baseFeatures({ stableDiff: 4 }),
    })
    const result = detectStableLoss(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('stable-loss')
    expect(result?.message).toBe('最善手なら確定石(絶対に取られない石)が4個増えていました。')
    expect(result?.severity).toBe(4)
    expect(result!.severity).toBeGreaterThanOrEqual(STABLE_LOSS_THRESHOLD)
    // ハイライトは実際の盤面上の確定石マス(最善手側は隅a1周辺4マス)。
    expect(result?.bestHighlightSquares.length).toBe(4)
    expect(result?.playedHighlightSquares.length).toBe(0)
  })

  it('確定石差が閾値未満なら検出しない', () => {
    const before = initialBoard()
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('f5'),
      playedFeatures: baseFeatures({ stableDiff: 1 }),
      bestFeatures: baseFeatures({ stableDiff: 2 }),
    })
    expect(detectStableLoss(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// detectClearBlunderPatterns(統合エントリポイント)
// ---------------------------------------------------------------------

describe('clearBlunder: detectClearBlunderPatterns(統合)', () => {
  it('明確な悪化パターンが1件も無ければnullを返す(合格扱いの起点、要件2)', () => {
    const before = createBoard(
      [notationToSquare('c1'), notationToSquare('b3'), notationToSquare('f3')],
      [notationToSquare('d1'), notationToSquare('b2'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('b1'),
    })
    expect(detectClearBlunderPatterns(input)).toBeNull()
  })

  it('複数検出時は影響の大きい順(severity降順)に最大2件を返す', () => {
    // 上と同じ局面でplayed/bestを入れ替えると、corner-gift(severity10)と
    // x-c-danger(severity6)の両方が同時に検出される
    // (b1はb2を挟む手であると同時に、隅a1に対するC打ちでもある。scratchpadで確認済み)。
    const before = createBoard(
      [notationToSquare('c1'), notationToSquare('b3'), notationToSquare('f3')],
      [notationToSquare('d1'), notationToSquare('b2'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b1'),
      bestSquare: notationToSquare('f5'),
    })
    const result = detectClearBlunderPatterns(input)
    expect(result).not.toBeNull()
    expect(result?.length).toBe(2)
    expect(result?.map((p) => p.id)).toEqual(['corner-gift', 'x-c-danger'])
    expect(result![0]!.severity).toBeGreaterThanOrEqual(result![1]!.severity)
  })

  it('1件だけ検出される場合はその1件のみを返す', () => {
    const { board, side } = boardAfterSequence(['f5', 'f4', 'c3', 'c4', 'd3', 'f6', 'b3', 'd6', 'g4', 'c2', 'e2', 'h4'])
    const input = makeInput({
      preMoveBoard: board,
      preMoveSide: side,
      playedSquare: notationToSquare('g6'),
      bestSquare: notationToSquare('b1'),
    })
    const result = detectClearBlunderPatterns(input)
    expect(result).not.toBeNull()
    expect(result?.length).toBe(1)
    expect(result?.[0]?.id).toBe('opponent-mobility')
  })
})
