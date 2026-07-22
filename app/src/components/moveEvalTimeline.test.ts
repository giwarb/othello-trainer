import { describe, expect, it } from 'vitest'
import {
  buildEvalGraphPoints,
  lastMoveEvalBarState,
  lastMoveEvalBarStateFor,
  type PlayedMoveEval,
} from './moveEvalTimeline.ts'

function move(partial: Partial<PlayedMoveEval> & Pick<PlayedMoveEval, 'ply' | 'side'>): PlayedMoveEval {
  return {
    notation: 'f5',
    discDiff: 0,
    source: 'midgame',
    isExact: false,
    ...partial,
  }
}

describe('buildEvalGraphPoints', () => {
  it('先頭にply0(初期局面、値0)を補う', () => {
    const points = buildEvalGraphPoints([])
    expect(points).toEqual([{ ply: 0, value: 0, isExact: false, evalSource: 'midgame' }])
  })

  it('黒の手はそのまま、白の手は符号反転して黒視点にする', () => {
    const points = buildEvalGraphPoints([
      move({ ply: 1, side: 'black', discDiff: 4, source: 'midgame' }),
      move({ ply: 2, side: 'white', discDiff: 3, source: 'midgame' }),
    ])
    expect(points[1]).toMatchObject({ ply: 1, value: 4, evalSource: 'midgame' })
    expect(points[2]).toMatchObject({ ply: 2, value: -3, evalSource: 'midgame' })
  })

  it('source===josekiの手は値0固定+evalSource joseki(discDiffが数値でも無視する)', () => {
    const points = buildEvalGraphPoints([move({ ply: 1, side: 'black', discDiff: 7, source: 'joseki' })])
    expect(points[1]).toMatchObject({ ply: 1, value: 0, evalSource: 'joseki', isExact: false })
  })

  it('discDiff===null(CPUの定石ブック手)は値0固定+evalSource josekiにする', () => {
    const points = buildEvalGraphPoints([move({ ply: 1, side: 'white', discDiff: null, source: 'midgame' })])
    expect(points[1]).toMatchObject({ ply: 1, value: 0, evalSource: 'joseki' })
  })

  it('isExactは手ごとの値をそのまま転記する(joseki扱いのときはfalse)', () => {
    const points = buildEvalGraphPoints([
      move({ ply: 1, side: 'black', discDiff: 10, source: 'exact', isExact: true }),
    ])
    expect(points[1]).toMatchObject({ isExact: true, evalSource: 'exact' })
  })

  describe('redo#1: pending(未解決)・配列の穴の防御', () => {
    it('pending: trueの手はグラフから除外する(evaluateHumanMove解決までのちらつき防止)', () => {
      const points = buildEvalGraphPoints([
        move({ ply: 1, side: 'black', discDiff: null, source: 'midgame', pending: true }),
      ])
      // ply0のみ(ply1のプレースホルダーは除外される)。
      expect(points).toEqual([{ ply: 0, value: 0, isExact: false, evalSource: 'midgame' }])
    })

    it('pendingの手の前後に解決済みの手があれば、pending分だけ除外して残りは通常どおり表示する', () => {
      const points = buildEvalGraphPoints([
        move({ ply: 1, side: 'black', discDiff: 5, source: 'midgame' }),
        move({ ply: 2, side: 'white', discDiff: null, source: 'midgame', pending: true }),
        move({ ply: 3, side: 'black', discDiff: 2, source: 'midgame' }),
      ])
      expect(points).toHaveLength(3) // ply0 + ply1 + ply3(ply2は除外)。
      expect(points.map((p) => p.ply)).toEqual([0, 1, 3])
    })

    it('配列に穴(undefined要素)があっても例外を投げず、その手だけスキップする(世代ガード漏れへの二重防御)', () => {
      // redo#1の重大指摘の再現: 古い`historyIndex`への書き込みが世代ガードを
      // すり抜けた場合、切り詰め後の短い配列に大きなindexで代入すると
      // JSの配列はその間を`undefined`で埋める(スパース配列)。
      const history: PlayedMoveEval[] = []
      history[0] = move({ ply: 1, side: 'black', discDiff: 1 })
      history[3] = move({ ply: 4, side: 'white', discDiff: -2 })
      // history[1], history[2] は`undefined`(穴)。

      expect(() => buildEvalGraphPoints(history)).not.toThrow()
      const points = buildEvalGraphPoints(history)
      expect(points.map((p) => p.ply)).toEqual([0, 1, 4]) // 穴(ply2,3相当)はスキップされる。
    })
  })
})

describe('lastMoveEvalBarStateFor(対局モードCPU・中盤練習の相手の直近の手)', () => {
  it('指定した側の手がまだ無ければnone', () => {
    expect(lastMoveEvalBarStateFor([], 'white')).toEqual({ kind: 'none' })
    expect(lastMoveEvalBarStateFor([move({ ply: 1, side: 'black' })], 'white')).toEqual({ kind: 'none' })
  })

  it('指定した側の直近の手を(間に他の側の手を挟んでいても)正しく拾う', () => {
    const history = [
      move({ ply: 1, side: 'black', discDiff: 2 }),
      move({ ply: 2, side: 'white', discDiff: -1 }),
      move({ ply: 3, side: 'black', discDiff: 3 }),
    ]
    expect(lastMoveEvalBarStateFor(history, 'white')).toEqual({ kind: 'value', side: 'white', discDiff: -1 })
  })

  it('discDiff===null(定石ブック手)はjoseki状態を返す', () => {
    const history = [move({ ply: 1, side: 'white', discDiff: null })]
    expect(lastMoveEvalBarStateFor(history, 'white')).toEqual({ kind: 'joseki', side: 'white' })
  })

  it('source===josekiの手はdiscDiffが数値でもjoseki状態を返す', () => {
    const history = [move({ ply: 1, side: 'white', discDiff: 5, source: 'joseki' })]
    expect(lastMoveEvalBarStateFor(history, 'white')).toEqual({ kind: 'joseki', side: 'white' })
  })

  it('redo#1: 直近の手がpending(未解決)なら、その手前の解決済みの手までさかのぼる', () => {
    const history = [
      move({ ply: 1, side: 'white', discDiff: -1 }),
      move({ ply: 2, side: 'white', discDiff: null, pending: true }),
    ]
    expect(lastMoveEvalBarStateFor(history, 'white')).toEqual({ kind: 'value', side: 'white', discDiff: -1 })
  })

  it('redo#1: 配列に穴(undefined要素)があっても例外を投げず、その手をスキップする', () => {
    const history: PlayedMoveEval[] = []
    history[0] = move({ ply: 1, side: 'white', discDiff: 4 })
    history[2] = undefined as unknown as PlayedMoveEval
    expect(() => lastMoveEvalBarStateFor(history, 'white')).not.toThrow()
    expect(lastMoveEvalBarStateFor(history, 'white')).toEqual({ kind: 'value', side: 'white', discDiff: 4 })
  })
})

describe('lastMoveEvalBarState(2人対戦モード用、手番を問わない直近の手)', () => {
  it('1手も無ければnone', () => {
    expect(lastMoveEvalBarState([])).toEqual({ kind: 'none' })
  })

  it('最後の手(直近の手番側)をそのまま返す', () => {
    const history = [
      move({ ply: 1, side: 'black', discDiff: 2 }),
      move({ ply: 2, side: 'white', discDiff: -4 }),
    ]
    expect(lastMoveEvalBarState(history)).toEqual({ kind: 'value', side: 'white', discDiff: -4 })
  })

  it('redo#1: 最後の手がpending(未解決)なら、その手前の解決済みの手までさかのぼる', () => {
    const history = [
      move({ ply: 1, side: 'black', discDiff: 2 }),
      move({ ply: 2, side: 'white', discDiff: null, pending: true }),
    ]
    expect(lastMoveEvalBarState(history)).toEqual({ kind: 'value', side: 'black', discDiff: 2 })
  })
})
