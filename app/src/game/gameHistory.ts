/**
 * 対局中に実際に打たれた着手の記録・棋譜解析への受け渡し用ヘルパー(T132)。
 *
 * 対局モード(`app.tsx`のPlayMode)は`gameLoop.ts`の`GameState`を`useState`で
 * 保持するのみで、着手履歴そのものは持たない。終局後に「この対局を棋譜解析で
 * 振り返る」導線(T132)を実現するには、着手のたびに`GameState`の遷移を観測して
 * 履歴を積み上げる必要がある。ここでの純粋関数群はPlayMode本体から切り出し、
 * Reactの描画に依存せず単体テストできるようにしたもの。
 */

import type { GameState } from './gameLoop.ts'
import { initialBoard, squareToNotation, type Board, type Side } from './othello.ts'

/**
 * 着手適用前後の`GameState`を比較し、実際に着手が成立していれば
 * (`lastMove`が変化していれば)その着手記法を`history`の末尾へ追記した新しい
 * 配列を返す。非合法手クリック等で状態が変化しなかった場合(`playMove`が
 * 同じ状態をそのまま返した場合)は`history`をそのまま(新しい配列として)返す。
 *
 * パス(`gameLoop.ts`の`afterMove`が両者の合法手の有無から自動的に手番を
 * 飛ばす処理)は着手として記録しない。これは棋譜解析側
 * (`analysis/parseTranscript.ts`・`analysis/analyzeGame.ts`の`replayGame`)が
 * 「棋譜文字列にパスを含めず、合法手の有無から自動的にパスを再現する」規約と
 * 揃えるためで、パスを含む対局でも記録された着手列をそのまま棋譜解析に渡せる。
 */
export function appendPlayedMove(
  history: readonly string[],
  prev: Pick<GameState, 'lastMove'>,
  next: Pick<GameState, 'lastMove'>,
): string[] {
  if (next.lastMove === null || next.lastMove === prev.lastMove) return [...history]
  return [...history, squareToNotation(next.lastMove)]
}

/**
 * `appendPlayedMove`で積み上げた着手記法列を、棋譜解析モードの
 * `parseTranscript`が読める標準トランスクリプト文字列(区切りなし連結)に変換する。
 */
export function movesToTranscript(moves: readonly string[]): string {
  return moves.join('')
}

/**
 * 対局の開始局面が標準初期局面(中央4マス標準配置・黒番)かどうかを判定する。
 * 盤面自由配置エディタ(`BoardEditor`)から開始した対局のうち、実際には
 * 標準初期局面のまま(手番も黒のまま)開始した場合は`true`を返す
 * (T132要件4: 「自由配置...対局でも初手からの通常対局なら動くこと。初期盤面が
 * 標準でない対局はボタンを出さない」)。
 */
export function isStandardStartPosition(board: Board, sideToMove: Side): boolean {
  if (sideToMove !== 'black') return false
  const initial = initialBoard()
  return board.black === initial.black && board.white === initial.white
}
