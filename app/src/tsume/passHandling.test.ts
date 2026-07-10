import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createBoard,
  hasLegalMove,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
} from '../game/othello.ts'
import { resolveMover } from '../midgame/resolveMover.ts'

/**
 * `tsume/PlayMode.tsx`のパス処理(T055)の単体テスト。
 *
 * `PlayMode.tsx`は着手適用(`applyMove`)の直後、着手適用と同じ関数呼び出しの
 * 中で`resolveMover(board, opposite(s.sideToMove))`を呼んで実際に手番を持つ側を
 * 解決してから`setSession`する(相手の着手を処理する`useEffect`・
 * `handlePlayerMove`のどちらも同じ形)。以前は着手適用とパス解決(手番反転)が
 * 別々の`useEffect`に分かれていたため、パスが発生した直後の1レンダーだけ
 * `session.sideToMove`が誤った値のまま描画され、盤面評価オーバーレイ取得用の
 * `useEffect`(`session.sideToMove !== session.humanSide`を見て判定する)が
 * 一瞬だけ`overlayMoves`を`null`にしてしまう(ちらつき)原因になっていた。
 *
 * ここでは、詰めオセロの出題盤面で実際に起こりうる「着手直後に相手側がパスし、
 * 着手した側が連続して手番を持つ」局面を`createBoard`で構成し、`PlayMode.tsx`と
 * 全く同じ呼び出し形(`resolveMover(board, opposite(movedSide))`)で、単純な
 * `opposite()`とは異なる(実際に手番を持つ側の)値が一度で得られることを検証する。
 */
describe('tsume/PlayMode のパス処理(resolveMoverの呼び出し形を直接検証)', () => {
  // `midgame/resolveMover.test.ts`の`buildIsolatedPocketsBoard`と同じ構成:
  // a1(黒) - b1(白) - c1(白) - d1(白) - (e1 空) に加え、h8(黒) - g8(白) - (f8 空)
  // という独立した領域を持つ盤面。黒がe1に着手するとb1-d1が返り、白はg8だけが
  // 孤立して合法手を失う一方、黒はf8への合法手をまだ持っている。
  function buildIsolatedPocketsBoard() {
    return createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
  }

  it('相手(白)の着手直後にパスが発生する詰めオセロ局面で、連続して手番を持つ側(黒)を1回で解決できる', () => {
    const board = buildIsolatedPocketsBoard()
    const movedSide = 'black'
    expect(legalMoves(board, movedSide)).toContain(notationToSquare('e1'))

    // PlayMode.tsx の handlePlayerMove / 相手の着手処理と全く同じ形の呼び出し。
    const boardAfterMove = applyMove(board, movedSide, notationToSquare('e1'))
    const naiveNextSide = opposite(movedSide) // 修正前の実装が使っていた単純な値
    const resolvedNextSide = resolveMover(boardAfterMove, naiveNextSide)

    expect(hasLegalMove(boardAfterMove, naiveNextSide)).toBe(false)
    expect(hasLegalMove(boardAfterMove, movedSide)).toBe(true)

    // 修正前は`naiveNextSide`(='white')がそのまま1レンダーぶんだけ
    // `session.sideToMove`にセットされてしまっていた。修正後は`resolveMover`が
    // 実際に手番を持つ側(movedSideである'black')を直接返すため、
    // `setSession`に渡す時点で既に正しい値になっている。
    expect(resolvedNextSide).toBe(movedSide)
    expect(resolvedNextSide).not.toBe(naiveNextSide)
  })

  it('通常どおり相手に合法手がある場合は、単純な opposite() と同じ値になる(パス以外では動作が変わらないことの確認)', () => {
    const movedSide = 'black'
    const boardAfterMove = applyMove(initialBoard(), movedSide, notationToSquare('d3'))
    const naiveNextSide = opposite(movedSide)

    expect(hasLegalMove(boardAfterMove, naiveNextSide)).toBe(true)
    expect(resolveMover(boardAfterMove, naiveNextSide)).toBe(naiveNextSide)
  })
})
