import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare } from '../game/othello.ts'
import { buildAttribution, replayContinuation } from './attribution.ts'
import { TranscriptReplayError } from './analyzeGame.ts'
import type { EvalTerms } from './types.ts'

/**
 * テスト用の`EvalTerms`フィクスチャを組み立てる。
 *
 * 【T031やり直し1回目・must 2対応】以前はここで`mobilityDiff`等の生の特徴量差分
 * だけを渡し、`buildAttribution`内部でTS側に複製した重み定数を掛けていたため、
 * テストが「TS側の重み定数」と「TS側の同じ重み定数」を比較するだけの循環参照に
 * なっていた(reviewer/verifier指摘)。修正後の`buildAttribution`は重み適用済みの
 * `mobilityTerm`/`cornerTerm`/`stableTerm`をそのまま差し引くだけなので、この
 * フィクスチャも「Rust側が返す想定の加重後の値」を直接渡す形にした
 * (`mobilityDiff`等の生の特徴量差分は`buildAttribution`が参照しないため、
 * インターフェースを満たすためだけのダミー値(0)を入れている)。
 * 実際にRust側が正しく加重しているかどうかの検証は
 * `engine/src/explain.rs`の`eval_terms_weighted_sum_matches_actual_evaluate_output`
 * 等、本物の`eval::evaluate`との突き合わせテストで行っている(このプロジェクトの
 * TS単体テストは実WASMを起動しない方針のため、Rust側で検証するのが適切)。
 */
function terms(mobilityTerm: number, cornerTerm: number, stableTerm: number, evaluateBlack = 0): EvalTerms {
  return { mobilityDiff: 0, cornerDiff: 0, stableDiff: 0, mobilityTerm, cornerTerm, stableTerm, evaluateBlack }
}

describe('analysis/attribution: buildAttribution', () => {
  it('黒視点で、各項目の寄与(加重後の値の差)を石差単位(centi-discの1/100)で計算する', () => {
    // A: mobilityTerm=506, cornerTerm=1088, stableTerm=0 (centi-disc)
    // B: すべて0
    const a = terms(506, 1088, 0)
    const b = terms(0, 0, 0)
    const result = buildAttribution(a, b, 'black')

    const mobilityTerm = result.terms.find((t) => t.key === 'mobility')!
    const cornerTerm = result.terms.find((t) => t.key === 'corner')!
    const stableTerm = result.terms.find((t) => t.key === 'stable')!

    expect(mobilityTerm.delta).toBeCloseTo(506 / 100, 9)
    expect(cornerTerm.delta).toBeCloseTo(1088 / 100, 9)
    expect(stableTerm.delta).toBeCloseTo(0, 9)
  })

  it('3項の合計(total)は各項目のdeltaの合計と一致する', () => {
    const a = terms(300, -200, 100)
    const b = terms(-100, 100, 0)
    const result = buildAttribution(a, b, 'black')

    const sumOfTerms = result.terms.reduce((sum, t) => sum + t.delta, 0)
    expect(result.total).toBeCloseTo(sumOfTerms, 9)
  })

  it('白視点では符号が反転する(黒視点で見た合計のちょうど-1倍)', () => {
    const a = terms(400, 200, 100)
    const b = terms(0, 0, 0)
    const blackView = buildAttribution(a, b, 'black')
    const whiteView = buildAttribution(a, b, 'white')

    expect(whiteView.total).toBeCloseTo(-blackView.total, 9)
    for (let i = 0; i < blackView.terms.length; i++) {
      expect(whiteView.terms[i]!.delta).toBeCloseTo(-blackView.terms[i]!.delta, 9)
    }
  })

  it('2局面が同一の加重後3項を持てば、分解結果はすべて0になる', () => {
    const a = terms(500, -300, 200)
    const result = buildAttribution(a, a, 'black')
    for (const term of result.terms) {
      expect(term.delta).toBeCloseTo(0, 9)
    }
    expect(result.total).toBeCloseTo(0, 9)
  })

  it('3つの項目(mobility/corner/stable)が過不足なく含まれる', () => {
    const result = buildAttribution(terms(100, 100, 100), terms(0, 0, 0), 'black')
    const keys = result.terms.map((t) => t.key).sort()
    expect(keys).toEqual(['corner', 'mobility', 'stable'])
  })

  it('本関数は重み定数を持たない(加重後の値をそのまま差し引くだけであることの回帰確認): 不自然な値を渡しても線形にそのまま反映される', () => {
    // must 2対応の要点: buildAttribution はもはや MOBILITY_WEIGHT 等の定数を
    // 一切参照しない。したがって「Rust側が本来ありえない重みで加重した値」を
    // 渡しても、buildAttribution はそれをそのまま(検証も再加重もせず)使う。
    // これはbuildAttributionが純粋な差分計算のみを行うことの回帰テスト。
    const a = terms(999999, -123456, 42)
    const b = terms(0, 0, 0)
    const result = buildAttribution(a, b, 'black')
    const mobilityTerm = result.terms.find((t) => t.key === 'mobility')!
    expect(mobilityTerm.delta).toBeCloseTo(999999 / 100, 6)
  })
})

describe('analysis/attribution: replayContinuation', () => {
  it('着手列を順番に適用し、applyMoveを直接呼んだ場合と同じ末端局面を返す', () => {
    const start = initialBoard()
    // 初期局面で黒がd3に着手した後、白の合法手の1つはc3。
    const moves = ['d3', 'c3']
    const result = replayContinuation(start, 'black', moves)

    let expected = start
    expected = applyMove(expected, 'black', notationToSquare('d3'))
    expected = applyMove(expected, 'white', notationToSquare('c3'))

    expect(result).toEqual(expected)
  })

  it('手順が空なら開始局面をそのまま返す', () => {
    const start = initialBoard()
    const result = replayContinuation(start, 'black', [])
    expect(result).toEqual(start)
  })

  it('非合法手を含む手順はTranscriptReplayErrorを投げる', () => {
    const start = initialBoard()
    // a1は初期局面の黒番にとって非合法手。
    expect(() => replayContinuation(start, 'black', ['a1'])).toThrow(TranscriptReplayError)
  })
})
