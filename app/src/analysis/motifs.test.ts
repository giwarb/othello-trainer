import { describe, expect, it } from 'vitest'
import { createBoard, initialBoard, legalMoves, notationToSquare } from '../game/othello.ts'
import { computeStableSquares } from './whyBad.ts'
import {
  computeBoardHighlights,
  detectBlock,
  detectCUchi,
  detectGusuuHouki,
  detectHenNoSencyaku,
  detectHipparu,
  detectJimetsu,
  detectKabezukuri,
  detectMotifs,
  detectNakawari,
  detectStoner,
  detectTanezukuriCreate,
  detectTanezukuriSupply,
  detectTezon,
  detectTooshi,
  detectXUchi,
  detectZengaeshi,
  frontierSquares,
  type MotifContext,
} from './motifs.ts'
import type { FeatureSet } from './types.ts'

/** テスト用にひとまず「無害」な既定値を持つ`FeatureSet`を作る(各テストで必要な部分だけ上書きする)。 */
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

/** 基本の(モチーフ検出には影響しない)着手前局面+着手: 初期局面のd3。 */
function neutralContext(featureOverrides: Partial<FeatureSet> = {}): MotifContext {
  return {
    beforeBoard: initialBoard(),
    side: 'black',
    square: notationToSquare('d3'),
    features: baseFeatures(featureOverrides),
  }
}

describe('motifs: 中割り(good)', () => {
  it('isUchiwariがtrueなら検出する', () => {
    expect(detectNakawari(neutralContext({ isUchiwari: true }))).toBe(true)
  })
  it('isUchiwariがfalseなら検出しない', () => {
    expect(detectNakawari(neutralContext({ isUchiwari: false }))).toBe(false)
  })
})

describe('motifs: ブロック(good)/手損(bad) - 着手可能数差(特徴量1)', () => {
  it('mobilityDiffが+4以上ならブロックを検出する', () => {
    expect(detectBlock(neutralContext({ mobilityDiff: 4 }))).toBe(true)
    expect(detectBlock(neutralContext({ mobilityDiff: 3 }))).toBe(false)
  })
  it('mobilityDiffが-4以下なら手損を検出する', () => {
    expect(detectTezon(neutralContext({ mobilityDiff: -4 }))).toBe(true)
    expect(detectTezon(neutralContext({ mobilityDiff: -3 }))).toBe(false)
  })
})

describe('motifs: 全返し(bad) - 開放度(特徴量3)', () => {
  it('opennessが6以上なら検出する', () => {
    expect(detectZengaeshi(neutralContext({ openness: 6 }))).toBe(true)
  })
  it('opennessが5以下なら検出しない', () => {
    expect(detectZengaeshi(neutralContext({ openness: 5 }))).toBe(false)
  })
})

describe('motifs: 種石供給(bad)/種石作り(good)', () => {
  it('seedStonesが1個以上あれば種石供給を検出する', () => {
    expect(detectTanezukuriSupply(neutralContext({ seedStones: ['b2'] }))).toBe(true)
    expect(detectTanezukuriSupply(neutralContext({ seedStones: [] }))).toBe(false)
  })

  it('種石作り: 着手後、自分の辺打ちで相手石を挟み返せる局面を検出する', () => {
    // 黒: c1, 白: b1(初期局面に追加)。黒がd3に着手した後も、黒はa1で
    // b1(白)を挟める(a1->b1(白)->c1(黒))ので、b1が「相手にとっての種石」になる。
    const initial = initialBoard()
    const beforeBoard = {
      black: initial.black | (1n << BigInt(notationToSquare('c1'))),
      white: initial.white | (1n << BigInt(notationToSquare('b1'))),
    }
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('d3'),
      features: baseFeatures(),
    }
    expect(detectTanezukuriCreate(ctx)).toBe(true)
  })

  it('種石作り: 辺上に挟み返せる相手石が無ければ検出しない(初期局面+d3)', () => {
    expect(detectTanezukuriCreate(neutralContext())).toBe(false)
  })
})

describe('motifs: 辺の先着(good)', () => {
  it('辺(上辺)が着手前に完全に空いていて、そこに初めて着手すれば検出する', () => {
    // 黒 d3, 白 d2 のみ。黒がd1(上辺)に着手すると d1->d2(白)->d3(黒) で挟める。
    const beforeBoard = createBoard([notationToSquare('d3')], [notationToSquare('d2')])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('d1'),
      features: baseFeatures(),
    }
    expect(legalMoves(beforeBoard, 'black')).toContain(notationToSquare('d1'))
    expect(detectHenNoSencyaku(ctx)).toBe(true)
  })

  it('着手先が辺のマスでなければ検出しない', () => {
    expect(detectHenNoSencyaku(neutralContext())).toBe(false)
  })

  it('辺に既に他の石があれば「先着」ではないので検出しない', () => {
    const beforeBoard = createBoard(
      [notationToSquare('d3'), notationToSquare('h1')],
      [notationToSquare('d2')],
    )
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('d1'),
      features: baseFeatures(),
    }
    expect(detectHenNoSencyaku(ctx)).toBe(false)
  })
})

describe('motifs: 引っ張り(good) - 相手のX/C打ちの好手を消す', () => {
  it('着手により、相手が持っていたX打ち(隅が空きのb2)の権利を消せば検出する', () => {
    // 黒 c2, 白 d2。黒がe2に着手するとd2(白)->c2(黒)でd2を裏返す(西方向)。
    // 着手前、白はb2(a1がまだ空きのX打ちマス)に合法手を持つ(b2->c2(黒,相手)->d2(白,自分)で挟める)。
    // 着手後d2が黒に変わるため、白のb2は不成立になる。
    const beforeBoard = createBoard([notationToSquare('c2')], [notationToSquare('d2')])
    expect(legalMoves(beforeBoard, 'white')).toContain(notationToSquare('b2'))
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('e2'),
      features: baseFeatures(),
    }
    expect(detectHipparu(ctx)).toBe(true)
  })

  it('相手のX/C打ちに影響しない着手では検出しない(初期局面+d3)', () => {
    expect(detectHipparu(neutralContext())).toBe(false)
  })
})

describe('motifs: 通し(good) - ライン(特徴量12)', () => {
  it('相手石0かつ自分の石が4個以上のラインがあれば検出する', () => {
    const features = baseFeatures({
      lines: [
        { name: 'main_diagonal', mover: 4, opponent: 0, empty: 4 },
        { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
      ],
    })
    expect(detectTooshi({ ...neutralContext(), features })).toBe(true)
  })

  it('相手石が混じっていれば検出しない', () => {
    const features = baseFeatures({
      lines: [
        { name: 'main_diagonal', mover: 6, opponent: 1, empty: 1 },
        { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
      ],
    })
    expect(detectTooshi({ ...neutralContext(), features })).toBe(false)
  })

  it('自分の石が閾値未満なら検出しない', () => {
    const features = baseFeatures({
      lines: [
        { name: 'main_diagonal', mover: 3, opponent: 0, empty: 5 },
        { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
      ],
    })
    expect(detectTooshi({ ...neutralContext(), features })).toBe(false)
  })
})

describe('motifs: 壁作り(bad) - フロンティア石数(特徴量4)の増加', () => {
  it('フロンティア石が2個以上増える着手を検出する(黒a1のみ→c1に着手、b1を裏返す)', () => {
    const beforeBoard = createBoard([notationToSquare('a1')], [notationToSquare('b1')])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('c1'),
      features: baseFeatures(),
    }
    expect(frontierSquares(beforeBoard, 'black')).toHaveLength(1)
    expect(detectKabezukuri(ctx)).toBe(true)
  })

  it('フロンティア石数が増えない(むしろ減る)着手では検出しない', () => {
    // 黒: a1,b1,c1,a2,a3,b3,c3,d2 / 白: c2。黒がb2に着手しc2を裏返すと、
    // a1・b1・a2が全近傍を石で囲まれ非フロンティア化し、正味では減少する
    // (作業ログに手計算の詳細を記載)。
    const blackSquares = ['a1', 'b1', 'c1', 'a2', 'a3', 'b3', 'c3', 'd2'].map(notationToSquare)
    const beforeBoard = createBoard(blackSquares, [notationToSquare('c2')])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b2'),
      features: baseFeatures(),
    }
    expect(legalMoves(beforeBoard, 'black')).toContain(notationToSquare('b2'))
    expect(detectKabezukuri(ctx)).toBe(false)
  })
})

describe('motifs: X打ち/C打ち(bad, 無根拠) - whyBad.tsの再利用', () => {
  it('X打ち(隅が空きのb2)を検出する', () => {
    const beforeBoard = createBoard(
      [notationToSquare('c3')],
      [notationToSquare('b3'), notationToSquare('a3')],
    )
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b2'),
      features: baseFeatures(),
    }
    expect(detectXUchi(ctx)).toBe(true)
    expect(detectCUchi(ctx)).toBe(false)
  })

  it('C打ち(隅が空きのb1)を検出する', () => {
    const beforeBoard = createBoard([notationToSquare('c3')], [])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b1'),
      features: baseFeatures(),
    }
    expect(detectCUchi(ctx)).toBe(true)
    expect(detectXUchi(ctx)).toBe(false)
  })

  it('通常の着手(初期局面+d3)ではどちらも検出しない', () => {
    const ctx = neutralContext()
    expect(detectXUchi(ctx)).toBe(false)
    expect(detectCUchi(ctx)).toBe(false)
  })
})

describe('motifs: 偶数放棄(bad) - 地域偶数', () => {
  // d列(file=3)を全て黒で埋め、盤を左(files0-2, 24マス)と右(files4-7, 32マス)の
  // 2領域に分割する。さらに右側にe4での黒の合法手(f4の白を挟む)、
  // 左側にa3での黒の合法手(a4の白を挟む)をそれぞれ用意する。
  function splitBoardContext(square: string): MotifContext {
    const dColumn = [0, 1, 2, 3, 4, 5, 6, 7].map((rank) => rank * 8 + 3)
    const black = [...dColumn, notationToSquare('g4'), notationToSquare('a5')]
    const white = [notationToSquare('f4'), notationToSquare('a4')]
    const beforeBoard = createBoard(black, white)
    return {
      beforeBoard,
      side: 'black',
      square: notationToSquare(square),
      features: baseFeatures(),
    }
  }

  it('最大かつ偶数の領域に(強制でなく)踏み込む着手を検出する', () => {
    const ctx = splitBoardContext('e4')
    expect(legalMoves(ctx.beforeBoard, 'black').length).toBeGreaterThan(1)
    expect(detectGusuuHouki(ctx)).toBe(true)
  })

  it('同じ局面でも、最大でない方の領域への着手では検出しない', () => {
    const ctx = splitBoardContext('a3')
    expect(detectGusuuHouki(ctx)).toBe(false)
  })

  it('領域が1つしかない(まだ分割されていない)序盤では検出しない', () => {
    expect(detectGusuuHouki(neutralContext())).toBe(false)
  })
})

describe('motifs: 自滅(bad) - 消える自分の手(特徴量5)', () => {
  it('lostOwnMovesが2個以上なら検出する', () => {
    expect(detectJimetsu(neutralContext({ lostOwnMoves: ['a1', 'b2'] }))).toBe(true)
  })
  it('lostOwnMovesが1個以下なら検出しない', () => {
    expect(detectJimetsu(neutralContext({ lostOwnMoves: ['a1'] }))).toBe(false)
    expect(detectJimetsu(neutralContext({ lostOwnMoves: [] }))).toBe(false)
  })
})

describe('motifs: ストナー(trap) - 辺の形(wing)+X筋の種石', () => {
  it('上辺がwing形状で、対応するX打ちマス(b2)が種石ならストナーを検出する', () => {
    const features = baseFeatures({
      edgeShapes: [
        { edge: 'top', shape: 'wing', emptyCount: 1 },
        { edge: 'bottom', shape: 'open', emptyCount: 4 },
        { edge: 'left', shape: 'open', emptyCount: 4 },
        { edge: 'right', shape: 'open', emptyCount: 4 },
      ],
      seedStones: ['b2'],
    })
    // 初期局面+d3ではa1(隅)は着手前後を通じて空きのまま。
    expect(detectStoner({ ...neutralContext(), features })).toBe(true)
  })

  it('wing形状でも対応するX筋が種石でなければ検出しない', () => {
    const features = baseFeatures({
      edgeShapes: [
        { edge: 'top', shape: 'wing', emptyCount: 1 },
        { edge: 'bottom', shape: 'open', emptyCount: 4 },
        { edge: 'left', shape: 'open', emptyCount: 4 },
        { edge: 'right', shape: 'open', emptyCount: 4 },
      ],
      seedStones: [],
    })
    expect(detectStoner({ ...neutralContext(), features })).toBe(false)
  })

  it('wing形状の辺が無ければ検出しない', () => {
    const features = baseFeatures({ seedStones: ['b2'] })
    expect(detectStoner({ ...neutralContext(), features })).toBe(false)
  })

  it('両隅とも埋まっていれば(開いた隅が無ければ)検出しない', () => {
    const initial = initialBoard()
    const beforeBoard = {
      black: initial.black | (1n << BigInt(notationToSquare('a1'))) | (1n << BigInt(notationToSquare('h1'))),
      white: initial.white,
    }
    const features = baseFeatures({
      edgeShapes: [
        { edge: 'top', shape: 'wing', emptyCount: 0 },
        { edge: 'bottom', shape: 'open', emptyCount: 4 },
        { edge: 'left', shape: 'open', emptyCount: 4 },
        { edge: 'right', shape: 'open', emptyCount: 4 },
      ],
      seedStones: ['b2'],
    })
    const ctx: MotifContext = { beforeBoard, side: 'black', square: notationToSquare('d3'), features }
    expect(detectStoner(ctx)).toBe(false)
  })
})

describe('motifs: detectMotifs(統合)', () => {
  it('複数のモチーフが同時に該当する局面で、それぞれ正しいkind/labelを含めて返す', () => {
    const ctx = neutralContext({ isUchiwari: true, seedStones: ['b2'], openness: 1 })
    const result = detectMotifs(ctx)
    const keys = result.map((m) => m.key)
    expect(keys).toContain('nakawari')
    expect(keys).toContain('tanezukuriSupply')
    expect(keys).not.toContain('zengaeshi')

    const nakawari = result.find((m) => m.key === 'nakawari')
    expect(nakawari).toEqual({ key: 'nakawari', label: '中割り', kind: 'good' })
    const supply = result.find((m) => m.key === 'tanezukuriSupply')
    expect(supply?.kind).toBe('bad')
  })

  it('どのモチーフにも該当しなければ空配列を返す', () => {
    // 「壁作り(bad)」の否定テストで使った局面(フロンティア石が正味減少する)を
    // 流用する。初期局面+d3のような「普通の」着手はフロンティアが+2増加し
    // 壁作りに該当してしまうため、意図的に該当しない局面を選ぶ必要がある。
    const blackSquares = ['a1', 'b1', 'c1', 'a2', 'a3', 'b3', 'c3', 'd2'].map(notationToSquare)
    const beforeBoard = createBoard(blackSquares, [notationToSquare('c2')])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b2'),
      features: baseFeatures({
        isUchiwari: false,
        mobilityDiff: 0,
        openness: 1,
        seedStones: [],
        lostOwnMoves: [],
        edgeShapes: [
          { edge: 'top', shape: 'open', emptyCount: 4 },
          { edge: 'bottom', shape: 'open', emptyCount: 4 },
          { edge: 'left', shape: 'open', emptyCount: 4 },
          { edge: 'right', shape: 'open', emptyCount: 4 },
        ],
        lines: [
          { name: 'main_diagonal', mover: 0, opponent: 0, empty: 8 },
          { name: 'anti_diagonal', mover: 0, opponent: 0, empty: 8 },
        ],
      }),
    }
    expect(detectMotifs(ctx)).toEqual([])
  })
})

describe('motifs: computeBoardHighlights(盤面オーバーレイ用マス集合、要件3)', () => {
  it('フロンティア・確定石・種石・危険なX/C打ちマスをそれぞれ正しく導出する', () => {
    const beforeBoard = createBoard(
      [notationToSquare('c3')],
      [notationToSquare('b3'), notationToSquare('a3')],
    )
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b2'),
      features: baseFeatures({ seedStones: ['c3'] }),
    }
    const highlights = computeBoardHighlights(ctx, computeStableSquares)

    // フロンティア: c3(黒)・b3/a3(白)は全て空きマスに隣接しているはず。
    expect(highlights.frontier).toEqual(expect.arrayContaining([notationToSquare('c3'), notationToSquare('b3')]))

    // 確定石: computeStableSquares(beforeBoard, 'black')と一致する。
    expect(new Set(highlights.stable)).toEqual(computeStableSquares(beforeBoard, 'black'))

    // 種石: seedStones(['c3'])をマス番号に変換したもの。
    expect(highlights.seed).toEqual([notationToSquare('c3')])

    // 危険なX/C打ちマス: a1がまだ空きなのでb2(X)・b1/a2(C)などが含まれる。
    expect(highlights.dangerousCorners).toEqual(expect.arrayContaining([notationToSquare('b2')]))
  })

  it('確定石(stable)が非空になる局面(隅を保持)でも正しく反映される', () => {
    // 隅a1を黒が保持していれば、`computeStableSquares`はa1を確定石として
    // 検出する(`whyBad.test.ts`の既存テストと同じ前提)。ブラウザでの実機確認
    // (T032作業ログ)では対局初期の局面しか試せず「確定石」トグルの非空ケースを
    // 確認できなかったため、その代替としてここで明示的に非空であることを検証する。
    const beforeBoard = createBoard([notationToSquare('a1'), notationToSquare('c3')], [])
    const ctx: MotifContext = {
      beforeBoard,
      side: 'black',
      square: notationToSquare('b2'),
      features: baseFeatures(),
    }
    const highlights = computeBoardHighlights(ctx, computeStableSquares)
    expect(highlights.stable).toContain(notationToSquare('a1'))
    expect(highlights.stable.length).toBeGreaterThan(0)
  })
})
