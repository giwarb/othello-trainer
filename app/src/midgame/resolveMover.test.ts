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
import { resolveMover, resolveNextSideOrFallback } from './resolveMover.ts'

/**
 * `resolveMover`(reviewer指摘のmust1対応)の単体テスト。
 *
 * `app/src/game/gameLoop.test.ts`の「pass handling」で使われているのと同じ
 * 局面構成手法(`createBoard`で意図的に「片側だけ合法手が無い」局面を作る)を
 * 流用し、`checkEnd`が以前誤って「即終局」と判定していたケースを直接・決定的に
 * 検証する。
 */
describe('resolveMover', () => {
  it('手番側に合法手があれば、そのまま手番側を返す', () => {
    const board = initialBoard()
    expect(hasLegalMove(board, 'black')).toBe(true)
    expect(resolveMover(board, 'black')).toBe('black')
  })

  // a1(黒) - b1(白) - c1(白) - d1(白) - (e1 空) の並びに加え、盤の反対側の隅に
  // h8(黒) - g8(白) - (f8 空) という独立した領域を用意する。
  // 黒がe1に着手するとb1-d1がひっくり返り、白石はg8だけが残る。この時点で
  // 白は合法手を持たない一方、黒はf8への合法手(g8を挟んでh8に到達)をまだ
  // 持っているため、「白パス・黒の連続手番」が発生する
  // (`game/gameLoop.test.ts`の`buildIsolatedPocketsBoard`と同じ構成)。
  function buildIsolatedPocketsBoard() {
    return createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
  }

  it('手番側に合法手が無く、相手側に合法手があれば、相手側を返す(パス。reviewer指摘のmust1のケース)', () => {
    const board = buildIsolatedPocketsBoard()
    expect(legalMoves(board, 'black')).toContain(notationToSquare('e1'))

    const afterE1 = applyMove(board, 'black', notationToSquare('e1'))
    expect(hasLegalMove(afterE1, 'white')).toBe(false)
    expect(hasLegalMove(afterE1, 'black')).toBe(true)

    // 修正前の`checkEnd`は、ここで`sideToMove === 'white'`(合法手なし)を見た
    // だけで即座に終局と誤判定していた。`resolveMover`は正しく黒(相手側)を返す。
    expect(resolveMover(afterE1, 'white')).toBe('black')
  })

  it('両者とも合法手が無ければnull(真の終局)を返す', () => {
    const board = buildIsolatedPocketsBoard()
    const afterE1 = applyMove(board, 'black', notationToSquare('e1'))
    const afterF8 = applyMove(afterE1, 'black', notationToSquare('f8'))

    expect(hasLegalMove(afterF8, 'black')).toBe(false)
    expect(hasLegalMove(afterF8, 'white')).toBe(false)
    expect(resolveMover(afterF8, 'black')).toBeNull()
    expect(resolveMover(afterF8, 'white')).toBeNull()
  })

  it('通常どおり相手側(白)に合法手がある局面では、そのまま白を返す', () => {
    const afterBlackMove = applyMove(initialBoard(), 'black', notationToSquare('d3'))
    expect(hasLegalMove(afterBlackMove, 'white')).toBe(true)
    expect(resolveMover(afterBlackMove, 'white')).toBe('white')
  })

  /**
   * `buildIsolatedPocketsBoard`の局面を、白の着手が起点になるよう左右反転した
   * 構成(独立した領域を維持したまま手番だけ入れ替えたもの)。
   * `resolveMover`/`resolveNextSideOrFallback`が「着手した側」に依らず
   * 対称に正しく動くこと(`tsume/PlayMode.tsx`では相手=エンジン側の着手後にも
   * 同じ関数を使うため)を確認するために使う。
   */
  function buildIsolatedPocketsBoardWhiteToMove() {
    return createBoard(
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
      [notationToSquare('a1'), notationToSquare('h8')],
    )
  }

  it('白が着手してパスが発生するケースでも、白の連続手番を正しく返す', () => {
    const board = buildIsolatedPocketsBoardWhiteToMove()
    expect(legalMoves(board, 'white')).toContain(notationToSquare('e1'))

    const afterE1 = applyMove(board, 'white', notationToSquare('e1'))
    expect(hasLegalMove(afterE1, 'black')).toBe(false)
    expect(hasLegalMove(afterE1, 'white')).toBe(true)
    expect(resolveMover(afterE1, 'black')).toBe('white')
  })
})

/**
 * `resolveNextSideOrFallback`(T055)の単体テスト。
 *
 * `midgame/PracticeMode.tsx`・`tsume/PlayMode.tsx`はいずれも、着手適用と
 * 同じ関数呼び出しの中でこの関数を使って次の手番を解決してから`setSession`
 * する(パス解決を別のuseEffectに任せない)。以前の実装は着手適用直後に
 * 単純に`opposite(sideToMove)`を計算するだけで、パスが発生した場合に
 * 実際とは異なる手番を1レンダーぶんだけ`session`にセットしてしまい、
 * それを見ている盤面評価オーバーレイ取得用のuseEffectが一瞬`overlayMoves`を
 * `null`にする(ちらつき)原因になっていた。ここでは、実際に両モードで
 * 発生する「着手後にパスが起きる」局面について、`resolveNextSideOrFallback`
 * が単純な`opposite()`とは異なる(＝実際に手番を持つ側の)値を返すことを
 * 直接検証し、この回帰を防ぐ。
 */
describe('resolveNextSideOrFallback', () => {
  function buildIsolatedPocketsBoard() {
    return createBoard(
      [notationToSquare('a1'), notationToSquare('h8')],
      [notationToSquare('b1'), notationToSquare('c1'), notationToSquare('d1'), notationToSquare('g8')],
    )
  }

  it('相手に合法手があれば、単純に相手側を返す(通常の手番交代)', () => {
    const board = applyMove(initialBoard(), 'black', notationToSquare('d3'))
    // `opposite('black') === 'white'`と一致する通常ケース。
    expect(resolveNextSideOrFallback(board, 'white')).toBe('white')
  })

  it('パスが発生する場合、単純な opposite() ではなく実際に手番を持つ側を返す(ちらつき修正の核心)', () => {
    const board = buildIsolatedPocketsBoard()
    const afterE1 = applyMove(board, 'black', notationToSquare('e1'))
    expect(hasLegalMove(afterE1, 'white')).toBe(false)
    expect(hasLegalMove(afterE1, 'black')).toBe(true)

    // 着手適用直後にコンポーネントが呼ぶのと同じ形: opposite(movedSide) を渡す。
    // 単純な opposite('black') === 'white' ではなく、実際に手番を持つ 'black' が
    // 返ることを確認する(白が誤ってオーバーレイ判定用のsessionに1テンポだけ
    // セットされることが無くなる)。
    expect(resolveNextSideOrFallback(afterE1, opposite('black'))).toBe('black')
  })

  it('両者とも合法手が無い(真の終局)場合は、渡した値をそのままフォールバックとして返す', () => {
    const board = buildIsolatedPocketsBoard()
    const afterE1 = applyMove(board, 'black', notationToSquare('e1'))
    const afterF8 = applyMove(afterE1, 'black', notationToSquare('f8'))
    expect(hasLegalMove(afterF8, 'black')).toBe(false)
    expect(hasLegalMove(afterF8, 'white')).toBe(false)

    expect(resolveNextSideOrFallback(afterF8, 'white')).toBe('white')
    expect(resolveNextSideOrFallback(afterF8, 'black')).toBe('black')
  })
})
