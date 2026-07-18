/**
 * 対局中に実際に打たれた着手の記録・棋譜解析への受け渡し用ヘルパー(T132)。
 *
 * 対局モード(`app.tsx`のPlayMode)は`gameLoop.ts`の`GameState`を`useState`で
 * 保持するのみで、着手履歴そのものは持たない。終局後に「この対局を棋譜解析で
 * 振り返る」導線(T132)を実現するには、着手のたびに`GameState`の遷移を観測して
 * 履歴を積み上げる必要がある。ここでの純粋関数群はPlayMode本体から切り出し、
 * Reactの描画に依存せず単体テストできるようにしたもの。
 */

import { createGame, playMove, type GameState } from './gameLoop.ts'
import { initialBoard, notationToSquare, squareToNotation, type Board, type Side } from './othello.ts'

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

/**
 * 標準初期局面(黒番)から`moves`(`appendPlayedMove`で積み上げた着手記法列、
 * パスを含まない)を順に適用して`GameState`を再構築する(T140「1手戻る」の
 * 実装方針: moveHistoryを正とし、undo時は初期局面から履歴prefixをリプレイする)。
 *
 * `playMove`は内部で`afterMove`のパス/終局判定規則を適用するため、記録に
 * 含まれないパスも自動的に再現される(`appendPlayedMove`のコメント参照)。
 * `isStandardStartPosition`が`true`の対局(=このモジュールが「振り返る」
 * ボタンや「1手戻る」ボタンを出す対象)にのみ使う想定で、開始局面自体は
 * `createGame`と同じ(`initialBoard()`・黒番)に固定する。
 */
export function replayMoves(humanSide: Side, vsHuman: boolean, moves: readonly string[]): GameState {
  let state = createGame(humanSide, { vsHuman })
  for (const move of moves) {
    state = playMove(state, notationToSquare(move))
  }
  return state
}

/**
 * 「1手戻る」(T140要件1)が保持すべき着手数(=`moveHistory`をこの長さへ
 * truncateすればよい)を求める。
 *
 * 2人対戦(`vsHuman`)は単純に1ply戻す(`moves.length - 1`、0未満にはしない)。
 *
 * CPU対戦は「自分(human側)の直前の手の直前まで戻る」規則を、`moves`を
 * 先頭から`replayMoves`と同じ手順で再生し各着手の手番側を復元することで
 * 実現する: 末尾から見てCPU側の着手が続く間は取り除き、続けて見つかった
 * human側の着手も1つ取り除く。
 *
 * - 通常(人間→CPUが1回ずつ応手): CPUの応手1件+人間の着手1件の計2件が
 *   取り除かれる。
 * - CPUが思考中(=まだCPUの応手が`moves`に積まれていない)場合: 末尾は
 *   既にhuman側の着手のため、上のループは何も取り除かず、続く1件
 *   (その人間の着手自身)だけが取り除かれる(要件1後段: 「思考中のCPU応手は
 *   破棄」)。
 * - 相手のパスにより同じ側の着手が連続する場合(`appendPlayedMove`の
 *   コメント参照)も、手番側の復元によって自然に扱える。
 * - 対局の最初の着手がまだ無い(`moves`が空)場合は0を返す。
 */
export function computeUndoLength(moves: readonly string[], humanSide: Side, vsHuman: boolean): number {
  if (vsHuman) return Math.max(0, moves.length - 1)

  let state = createGame(humanSide, { vsHuman })
  const sides: Side[] = []
  for (const move of moves) {
    sides.push(state.sideToMove)
    state = playMove(state, notationToSquare(move))
  }

  let cut = moves.length
  while (cut > 0 && sides[cut - 1] !== humanSide) cut -= 1
  if (cut > 0) cut -= 1
  return cut
}
