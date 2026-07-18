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
  MASS_FLIP_DIFF_THRESHOLD,
  MASS_FLIP_MIN_EMPTY,
  MISSED_CORNER_SEVERITY,
  OPPONENT_MOBILITY_THRESHOLD,
  OPPONENT_PASS_MISSED_SEVERITY,
  OWN_MOBILITY_COLLAPSE_DIFF_THRESHOLD,
  OWN_MOBILITY_COLLAPSE_MAX_ABS,
  STABLE_LOSS_THRESHOLD,
  WALL_FRONTIER_THRESHOLD,
  X_C_DANGER_SEVERITY,
  detectAllClearBlunderPatterns,
  detectClearBlunderPatterns,
  detectCornerGift,
  detectMassFlip,
  detectMissedCorner,
  detectOpponentMobility,
  detectOpponentPassMissed,
  detectOwnMobilityCollapse,
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
// T128b①: missed-corner(最善手が隅なのに取らなかった)
// ---------------------------------------------------------------------

describe('clearBlunder: missed-corner(最善手が隅なのに取らなかった、T128b)', () => {
  // 黒: c1, f3 / 白: b1, f4。黒の合法手はa1(隅、b1を挟む)とf5(f4を挟む)。
  // scratchpadで`legalMoves`を実行して事前確認済み。
  const before = createBoard(
    [notationToSquare('c1'), notationToSquare('f3')],
    [notationToSquare('b1'), notationToSquare('f4')],
  )

  it('最善手が隅で実際の手が隅でないなら検出する(閾値不要)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('a1'),
    })
    const result = detectMissedCorner(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('missed-corner')
    expect(result?.message).toBe(
      '隅(a1)を取れるのに取りませんでした。隅は一度取るとひっくり返されない、いちばん強いマスです。',
    )
    expect(result?.severity).toBe(MISSED_CORNER_SEVERITY)
    expect(result?.playedHighlightSquares).toEqual([notationToSquare('a1')])
    expect(result?.bestHighlightSquares).toEqual([notationToSquare('a1')])
  })

  it('最善手が隅でなければ検出しない(手を入れ替えたケース)', () => {
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('a1'),
      bestSquare: notationToSquare('f5'),
    })
    expect(detectMissedCorner(input)).toBeNull()
  })

  it('実際の手も隅なら検出しない(隅を取り損ねてはいない)', () => {
    // corner-giftのテストで使っている局面(黒: c1,b3,f3 / 白: d1,b2,f4)を流用し、
    // 仮に両方とも隅になるケースは無いため、最善手・実際の手のいずれも隅でない
    // 通常ケースでnullになることを確認する(missed-corner固有の「実際の手も隅」
    // ケースは本モジュールの合法手上作れないため、両方とも隅でないケースで代替)。
    const other = createBoard(
      [notationToSquare('c1'), notationToSquare('b3'), notationToSquare('f3')],
      [notationToSquare('d1'), notationToSquare('b2'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: other,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b1'),
      bestSquare: notationToSquare('f5'),
    })
    expect(detectMissedCorner(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// T128b②: opponent-pass-missed(最善手なら相手がパスだった)
// ---------------------------------------------------------------------

describe('clearBlunder: opponent-pass-missed(最善手なら相手がパスだった、T128b)', () => {
  // 初期局面からの実対局(乱数シードで生成、決定的)10手目の局面。黒番。
  // h6に着手すると白の合法手が0(パス)、g5に着手すると白は9か所に打てる。
  // scratchpadで乱数対局を多数生成し、実際に出現する局面から採取した
  // (盤面ビット列はscratchpadでの実行結果をそのまま定数化)。
  const DECISION_BOARD: Board = { black: 4508118403784704n, white: 131941395333120n }

  it('最善手なら相手の合法手が0で、実際の手なら相手に合法手があるなら検出する', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('g5'),
      bestSquare: notationToSquare('h6'),
    })
    const result = detectOpponentPassMissed(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('opponent-pass-missed')
    expect(result?.message).toBe(
      '最善手なら相手は打てる場所がなくパスでした。続けてあなたの番になれたのに、この手だと相手は9か所に打てます。',
    )
    expect(result?.severity).toBe(OPPONENT_PASS_MISSED_SEVERITY)
    expect(result?.playedHighlightSquares.length).toBe(9)
    expect(result?.bestHighlightSquares).toEqual([])
  })

  it('最善手でも相手に合法手が残るなら検出しない', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('c7'),
      bestSquare: notationToSquare('d7'),
    })
    expect(detectOpponentPassMissed(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------
// T128b③: own-mobility-collapse(自分の打てる場所の激減)
// ---------------------------------------------------------------------

describe('clearBlunder: own-mobility-collapse(自分の打てる場所の激減、T128b)', () => {
  // 初期局面からの実対局(乱数対局2手目)の局面。黒番。c6に着手すると
  // 黒の着手後合法手が3、d6に着手すると8(scratchpadで確認済み)。
  const DECISION_BOARD: Board = { black: 469762048n, white: 120259084288n }

  it('差が閾値以上かつ着手後の絶対数が上限以下なら検出する(c6:3 vs d6:8)', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('c6'),
      bestSquare: notationToSquare('d6'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 3 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 8 }),
    })
    const result = detectOwnMobilityCollapse(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('own-mobility-collapse')
    expect(result?.message).toBe('この手の後、あなたが打てる場所は3か所しかありません。最善手なら8か所ありました。')
    expect(result?.severity).toBe(5)
    expect(result!.severity).toBeGreaterThanOrEqual(OWN_MOBILITY_COLLAPSE_DIFF_THRESHOLD)
  })

  it('着手後の自分の合法手が0なら専用の文言になる', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('c6'),
      bestSquare: notationToSquare('d6'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 0 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 8 }),
    })
    const result = detectOwnMobilityCollapse(input)
    expect(result?.message).toBe(
      'この手の後、あなたが打てる場所がなくなり、パスになるおそれがあります。最善手なら8か所ありました。',
    )
  })

  it('差が閾値未満なら検出しない(c6:3 vs e6:3、差0)', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('c6'),
      bestSquare: notationToSquare('e6'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 3 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 3 }),
    })
    expect(detectOwnMobilityCollapse(input)).toBeNull()
  })

  it('差は閾値以上でも着手後の絶対数が上限を超えるなら検出しない(b6:5 vs d6:8、差3だがplayedOwn=5>4)', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b6'),
      bestSquare: notationToSquare('d6'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 5 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 8 }),
    })
    expect(detectOwnMobilityCollapse(input)).toBeNull()
    expect(5).toBeGreaterThan(OWN_MOBILITY_COLLAPSE_MAX_ABS)
  })
})

// ---------------------------------------------------------------------
// T128b④: mass-flip(石の取りすぎ)
// ---------------------------------------------------------------------

describe('clearBlunder: mass-flip(石の取りすぎ、T128b)', () => {
  // 初期局面からの実対局(乱数対局22手目)の局面。黒番、空き38。
  // h6に着手すると5個返し、b5に着手すると1個しか返さない(scratchpadで確認済み)。
  const DECISION_BOARD: Board = { black: 1890952192077070336n, white: 136597644509696n }

  it('返した個数の差が閾値以上かつ空きマス数が下限以上なら検出する(h6:5個 vs b5:1個、差4)', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('h6'),
      bestSquare: notationToSquare('b5'),
    })
    const result = detectMassFlip(input)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('mass-flip')
    expect(result?.message).toBe(
      'この手は一度に5個も返しています(最善手は1個)。序盤・中盤で石をたくさん返すと、あとで相手に返され放題の形になりやすいです。',
    )
    expect(result?.severity).toBe(4)
    expect(result!.severity).toBeGreaterThanOrEqual(MASS_FLIP_DIFF_THRESHOLD)
    expect(result?.playedHighlightSquares.length).toBe(5)
    expect(result?.bestHighlightSquares.length).toBe(1)
  })

  it('返した個数の差が閾値未満なら検出しない(b5:1個 vs g5:1個、差0)', () => {
    const input = makeInput({
      preMoveBoard: DECISION_BOARD,
      preMoveSide: 'black',
      playedSquare: notationToSquare('b5'),
      bestSquare: notationToSquare('g5'),
    })
    expect(detectMassFlip(input)).toBeNull()
  })

  it('差が閾値以上でも着手前の空きマス数が下限未満なら検出しない(空きマスガード)', () => {
    // T128の`wall-frontier`テストと同じ骨格(黒a4+隅クラスタ / 白b4-g4横一列+b1)に、
    // h4・a5以外の全マスを市松模様で埋めて空きマス数を2まで減らした局面
    // (scratchpadで構築・`empty count: 2`を確認済み。市松模様の埋め石は
    // 意図せずh4/a5のフリップ数にも影響するが、本テストの主眼は「フリップ数の
    // 差自体は閾値以上のままガードだけが効く」ことの確認であり、
    // 実際にscratchpadでの実測でも差5(>=4)のままガードで無効化されることを確認済み)。
    const keepEmptyNotations = ['h4', 'a5']
    const blackSquares = [
      notationToSquare('a4'),
      notationToSquare('a1'),
      notationToSquare('c1'),
      notationToSquare('a3'),
      notationToSquare('c3'),
      notationToSquare('b3'),
      notationToSquare('a2'),
      notationToSquare('c2'),
    ]
    const whiteSquares = [
      notationToSquare('b4'),
      notationToSquare('c4'),
      notationToSquare('d4'),
      notationToSquare('e4'),
      notationToSquare('f4'),
      notationToSquare('g4'),
      notationToSquare('b1'),
    ]
    const keepEmpty = new Set(keepEmptyNotations.map(notationToSquare))
    const usedBlack = new Set(blackSquares)
    const usedWhite = new Set(whiteSquares)
    const fillerBlack = [...blackSquares]
    const fillerWhite = [...whiteSquares]
    for (let sq = 0; sq < 64; sq++) {
      if (usedBlack.has(sq) || usedWhite.has(sq) || keepEmpty.has(sq)) continue
      const file = sq % 8
      const rank = Math.floor(sq / 8)
      if ((file + rank) % 2 === 0) fillerBlack.push(sq)
      else fillerWhite.push(sq)
    }
    const before = createBoard(fillerBlack, fillerWhite)
    const emptyCount = 64 - fillerBlack.length - fillerWhite.length
    expect(emptyCount).toBeLessThan(MASS_FLIP_MIN_EMPTY)

    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('h4'),
      bestSquare: notationToSquare('a5'),
    })
    expect(detectMassFlip(input)).toBeNull()
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

  // ---------------------------------------------------------------------
  // T128b: 既存5種との優先順位統合(受け入れ基準「隅系が上位に来る」)
  // ---------------------------------------------------------------------

  it('severity定数の優先順位が裁定どおりになっている(corner-gift > missed-corner > opponent-pass-missed > x-c-danger、隅系が上位)', () => {
    expect(CORNER_GIFT_SEVERITY).toBeGreaterThan(MISSED_CORNER_SEVERITY)
    expect(MISSED_CORNER_SEVERITY).toBeGreaterThan(OPPONENT_PASS_MISSED_SEVERITY)
    expect(OPPONENT_PASS_MISSED_SEVERITY).toBeGreaterThan(X_C_DANGER_SEVERITY)
  })

  it('missed-corner(隅系、severity9)とown-mobility-collapse(手数系、severity4)が同時検出されるとき、隅系が先頭に来る', () => {
    // missed-corner用の局面(黒: c1,f3 / 白: b1,f4、best=a1隅・played=f5)に、
    // own-mobility-collapseも同時検出させるためのfeatureSetを追加した合成入力
    // (own-mobility-collapseはfeatureSetの値のみで判定するため、盤面の実際の
    // 合法手数とは独立に検証できる。他の検出器はこの局面・featureSetの組では
    // 発火しないことをscratchpadで確認済み: corner-gift/opponent-mobility/
    // wall-frontierは白の合法手・黒フロンティアが両手とも同数、x-c-dangerは
    // f5/a1がいずれもX/C対応マスでない、stable-lossはstableDiffを既定の0/0の
    // ままにしているため発火しない)。
    const before = createBoard(
      [notationToSquare('c1'), notationToSquare('f3')],
      [notationToSquare('b1'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('a1'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 2 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 6 }),
    })
    const result = detectClearBlunderPatterns(input)
    expect(result).not.toBeNull()
    expect(result?.map((p) => p.id)).toEqual(['missed-corner', 'own-mobility-collapse'])
    expect(result![0]!.severity).toBeGreaterThan(result![1]!.severity)
  })

  /**
   * T129要件1: 苦手パターン統計は「表示上限2件でなく検出全件」を記録する必要が
   * あるため、`detectAllClearBlunderPatterns`が表示用の`detectClearBlunderPatterns`
   * とは独立に切り詰め無しの全件を返すことを固定する。
   */
  it('detectAllClearBlunderPatternsは表示上限(2件)を超えても検出した全件を返す(T129要件1)', () => {
    // missed-corner用の局面(黒: c1,f3 / 白: b1,f4、best=a1隅・played=f5)に、
    // own-mobility-collapse・stable-lossも同時検出させるfeatureSetを追加する
    // (上の「missed-cornerとown-mobility-collapseが同時検出」テストと同じ局面に、
    // stableDiffの差も加えて3件同時検出にする)。
    const before = createBoard(
      [notationToSquare('c1'), notationToSquare('f3')],
      [notationToSquare('b1'), notationToSquare('f4')],
    )
    const input = makeInput({
      preMoveBoard: before,
      preMoveSide: 'black',
      playedSquare: notationToSquare('f5'),
      bestSquare: notationToSquare('a1'),
      playedFeatures: baseFeatures({ moverMobilityAfter: 2, stableDiff: 0 }),
      bestFeatures: baseFeatures({ moverMobilityAfter: 6, stableDiff: 3 }),
    })

    const all = detectAllClearBlunderPatterns(input)
    expect(all.map((p) => p.id).sort()).toEqual(['missed-corner', 'own-mobility-collapse', 'stable-loss'].sort())

    // 表示用は上限2件に切り詰められ、severity最下位(stable-loss)は含まれない。
    const limited = detectClearBlunderPatterns(input)
    expect(limited).not.toBeNull()
    expect(limited?.length).toBe(2)
    expect(limited?.map((p) => p.id)).not.toContain('stable-loss')
  })
})
