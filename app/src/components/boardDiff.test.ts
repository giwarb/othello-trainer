import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createBoard,
  initialBoard,
  notationToSquare,
} from '../game/othello.ts'
import { diffBoards } from './boardDiff.ts'

/**
 * `diffBoards`(T066、石の反転アニメーション)の単体テスト。
 *
 * 「1手適用による通常の盤面遷移」かどうかの判定が、実際の`applyMove`の
 * 結果(通常の着手・パス)と、`Board.tsx`がジャンプとして扱うべき変化
 * (新規対局リセット、棋譜解析での別局面へのジャンプ)を正しく区別できることを
 * 決定的な盤面構成で検証する。
 */
describe('diffBoards', () => {
  it('通常の1手着手では isSingleMove=true になり、配置マス・反転マスを正しく返す', () => {
    const before = initialBoard()
    const d3 = notationToSquare('d3')
    const after = applyMove(before, 'black', d3)

    const diff = diffBoards(before, after)

    expect(diff.isSingleMove).toBe(true)
    expect(diff.placed).toEqual([d3])
    // 初期局面から黒がd3に着手すると、挟まれた白石(c4)がちょうど1マス反転する。
    // 具体的な反転マスの正しさは`applyMove`自体のテスト(`game/othello.test.ts`)
    // の責務なので、ここでは「配置マスとは別に、ちょうど1マス反転していること」
    // を確認する。
    expect(diff.flipped.length).toBe(1)
    expect(diff.flipped).not.toContain(d3)
  })

  it('パス(盤面が変化しない)では isSingleMove=false になり、配置マス・反転マスは空になる', () => {
    // 盤面が全く変化しないケース(パス時に`board`参照がそのまま維持される想定)。
    const board = initialBoard()

    const diff = diffBoards(board, board)

    expect(diff.isSingleMove).toBe(false)
    expect(diff.placed).toEqual([])
    expect(diff.flipped).toEqual([])
  })

  it('新規対局リセット(石数が減る)では isSingleMove=false になる', () => {
    const midGame = applyMove(initialBoard(), 'black', notationToSquare('d3'))
    const resetToInitial = initialBoard()

    const diff = diffBoards(midGame, resetToInitial)

    expect(diff.isSingleMove).toBe(false)
    expect(diff.placed).toEqual([])
    expect(diff.flipped).toEqual([])
  })

  it('棋譜解析での別局面へのジャンプ(2手分の差)では isSingleMove=false になる', () => {
    const afterMove1 = applyMove(initialBoard(), 'black', notationToSquare('d3'))
    const afterMove2 = applyMove(afterMove1, 'white', notationToSquare('c3'))

    // 「1手戻る/進む」の単純操作ではなく、間の局面を飛ばして直接ジャンプする
    // ケース(ムーブリストの別の手をクリックして局面をジャンプする操作を模す)。
    const diff = diffBoards(initialBoard(), afterMove2)

    expect(diff.isSingleMove).toBe(false)
    expect(diff.placed).toEqual([])
    expect(diff.flipped).toEqual([])
  })

  it('分岐探索・待った等で石数が同じまま別局面に切り替わるケースでも isSingleMove=false になる', () => {
    // 石が消えたマスがある(=旧盤面の占有マスが新盤面に全て維持されていない)
    // 人為的な局面構成。総石数の差だけでは判定できないケースを直接検証する。
    const before = createBoard(
      [notationToSquare('a1'), notationToSquare('b1')],
      [notationToSquare('c1')],
    )
    const after = createBoard(
      [notationToSquare('a1')],
      [notationToSquare('c1'), notationToSquare('d1'), notationToSquare('e1')],
    )

    const diff = diffBoards(before, after)

    expect(diff.isSingleMove).toBe(false)
    expect(diff.placed).toEqual([])
    expect(diff.flipped).toEqual([])
  })

  it('通常の1手着手で複数マスが反転するケースでも、配置マスと反転マスを正しく分離する', () => {
    // b1(黒) - c1(白) - d1(白) - e1(白) の並びに、黒がf1に着手すると
    // c1・d1・e1の3マスがまとめて反転する。
    const before = createBoard(
      [notationToSquare('b1')],
      [notationToSquare('c1'), notationToSquare('d1'), notationToSquare('e1')],
    )
    const f1 = notationToSquare('f1')
    const after = applyMove(before, 'black', f1)

    const diff = diffBoards(before, after)

    expect(diff.isSingleMove).toBe(true)
    expect(diff.placed).toEqual([f1])
    expect(diff.flipped).toEqual([
      notationToSquare('c1'),
      notationToSquare('d1'),
      notationToSquare('e1'),
    ])
  })
})
