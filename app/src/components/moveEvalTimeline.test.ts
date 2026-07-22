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
})
