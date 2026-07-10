/**
 * 実際に手番を持つ側を解決する(パス処理、reviewer指摘のmust1対応)。
 *
 * `sideToMove`に合法手が無くても、相手側に合法手があれば真の終局ではなく
 * 「パスして相手側の手番になるだけ」である(`game/gameLoop.ts`の`afterMove`が
 * 対局モードで同じ規則を実装しており、それと同一のロジックをここに切り出した)。
 * 両者とも合法手が無い場合のみ終局(`null`)とする。
 *
 * `PracticeMode.tsx`の`checkEnd`はこの関数で実際の手番側を解決してから
 * `requestAnalyzeAll`を呼ぶ。以前の実装は`sideToMove`に合法手が無いだけで
 * 即座に終局(`finishByFinalScore`)と誤判定しており、空き24以下(`exactFromEmpties`
 * により毎手この判定を通る)の終盤でパスが起きるたびに誤って「失敗」を確定して
 * しまい、クリアまで到達できなくなっていた。純粋関数として切り出すことで、
 * 実際のオセロ盤面(`game/othello.ts`の`createBoard`で構成)を使った決定的な
 * 単体テストで検証できるようにしている(`resolveMover.test.ts`参照)。
 */

import { hasLegalMove, opposite, type Board, type Side } from '../game/othello.ts'

/**
 * `board`において実際に手番を持つ側を返す。
 * - `sideToMove`に合法手があれば`sideToMove`をそのまま返す。
 * - `sideToMove`に合法手が無く、相手に合法手があれば相手側を返す(パス)。
 * - どちらにも合法手が無ければ`null`を返す(終局)。
 */
export function resolveMover(board: Board, sideToMove: Side): Side | null {
  if (hasLegalMove(board, sideToMove)) return sideToMove
  if (hasLegalMove(board, opposite(sideToMove))) return opposite(sideToMove)
  return null
}

/**
 * `resolveMover`を使い、着手適用直後に実際の手番を持つ側を解決する
 * (T055、着手適用と同期してパスを解決するためのヘルパー)。
 *
 * `PracticeMode.tsx`の`checkEnd`/`resetSessionTo`/`handlePlayerMove`/相手の
 * 着手処理は、いずれも着手(または開始局面設定)を適用した直後にこの関数で
 * 次の手番側を解決してから`setSession`する。以前は着手適用と手番解決(パス処理)
 * が別々のuseEffectに分かれていたため、パスが発生した直後の1レンダーだけ
 * `session.sideToMove`が誤った値(単純な`opposite(sideAfterMove)`)のまま
 * 描画され、それを見ている盤面評価オーバーレイ取得用のuseEffectが一瞬だけ
 * 誤判定して`overlayMoves`を`null`にしてしまう(ちらつき)原因になっていた。
 *
 * 両者とも合法手が無い(真の終局)の場合は`sideAfterMove`をそのまま返す。
 * この関数は終局判定そのものは行わないため、呼び出し側は別途`resolveMover`の
 * 結果(`null`かどうか)で終局を判定すること(`checkEnd`参照)。
 */
export function resolveNextSideOrFallback(board: Board, sideAfterMove: Side): Side {
  return resolveMover(board, sideAfterMove) ?? sideAfterMove
}
