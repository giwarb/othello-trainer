/**
 * 対局(人間 vs エンジン)の進行ロジック。
 *
 * 盤面表現・合法手判定・着手適用はT011の `othello.ts` をそのまま用いる
 * (人間の着手判定・盤面表示はTS側実装、CPUの着手のみT012のエンジンに問い合わせる、
 * という役割分担。詳細は `tasks/T013-play-mode.md` 参照)。
 *
 * UI(Preactコンポーネント)からは独立した純粋なロジックとして実装してあり、
 * Vitestで単体テスト可能。
 */

import type { AnalyzeLimit } from '../engine/types.ts'
import {
  applyMove,
  countDiscs,
  hasLegalMove,
  initialBoard,
  legalMoves,
  notationToSquare,
  opposite,
  type Board,
  type Side,
} from './othello.ts'

/** 対局の進行フェーズ。`'human'`/`'cpu'` はどちらの手番かを表し、`'over'` は終局を表す。 */
export type GamePhase = 'human' | 'cpu' | 'over'

/** 勝敗(引き分けを含む)。 */
export type GameResult = Side | 'draw'

export interface GameState {
  readonly board: Board
  /** 現在の手番。終局後(`phase === 'over'`)は最後に着手した側のまま据え置く。 */
  readonly sideToMove: Side
  /** 人間が担当する色。CPUは `opposite(humanSide)`。 */
  readonly humanSide: Side
  /** 直前の着手マス(初手前は `null`)。 */
  readonly lastMove: number | null
  readonly phase: GamePhase
  /** 直前の着手直後にパスが発生した場合の通知文言(発生していなければ `null`)。 */
  readonly passMessage: string | null
  /** 終局している場合の勝敗(終局していなければ `null`)。 */
  readonly result: GameResult | null
}

/**
 * CPUの着手取得に必要な最小限のインターフェース。
 * T012の `EngineClient.requestAnalyze` はこれを満たすため、本番ではそのまま渡せる。
 * 単体テストでは `pv` フィールドだけを持つモックに差し替えられる。
 */
export interface EngineQuery {
  requestAnalyze(board: Board, turn: Side, limit: AnalyzeLimit): Promise<{ pv: readonly string[] }>
}

function phaseFor(side: Side, humanSide: Side): GamePhase {
  return side === humanSide ? 'human' : 'cpu'
}

function decideResult(board: Board): GameResult {
  const black = countDiscs(board, 'black')
  const white = countDiscs(board, 'white')
  if (black > white) return 'black'
  if (white > black) return 'white'
  return 'draw'
}

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

/** 新規対局を開始する。オセロは常に黒番から始まる。`humanSide` は人間が担当する色。 */
export function createGame(humanSide: Side): GameState {
  return {
    board: initialBoard(),
    sideToMove: 'black',
    humanSide,
    lastMove: null,
    phase: phaseFor('black', humanSide),
    passMessage: null,
    result: null,
  }
}

/**
 * 着手適用後の状態遷移(手番交代・パス・終局判定)をまとめたヘルパー。
 * 人間の着手・CPUの着手のどちらの後に呼ばれても同じ規則が適用される。
 *
 * - 次の手番(相手)に合法手があれば、そのまま手番交代する。
 * - 相手に合法手がなく、着手した側にはまだ合法手があれば、
 *   相手はパスしたものとして着手した側が続けて手番を持つ(`passMessage` を設定)。
 * - どちらにも合法手がなければ終局とする。
 */
function afterMove(board: Board, movedSide: Side, lastMove: number, humanSide: Side): GameState {
  const opponent = opposite(movedSide)

  if (hasLegalMove(board, opponent)) {
    return {
      board,
      sideToMove: opponent,
      humanSide,
      lastMove,
      phase: phaseFor(opponent, humanSide),
      passMessage: null,
      result: null,
    }
  }

  if (hasLegalMove(board, movedSide)) {
    return {
      board,
      sideToMove: movedSide,
      humanSide,
      lastMove,
      phase: phaseFor(movedSide, humanSide),
      passMessage: `${sideLabel(opponent)}はパスしました`,
      result: null,
    }
  }

  return {
    board,
    sideToMove: movedSide,
    humanSide,
    lastMove,
    phase: 'over',
    passMessage: null,
    result: decideResult(board),
  }
}

/**
 * その時点の手番側が `square` に着手する(人間・CPUどちらの着手にも使う共通ロジック)。
 *
 * 以下の場合は何もせず同じ `state` をそのまま返す:
 * - 既に終局している場合(`state.phase === 'over'`)
 * - `square` が現在の手番にとって合法手でない場合(非合法手クリックは無視する仕様)
 */
export function playMove(state: GameState, square: number): GameState {
  if (state.phase === 'over') return state

  const side = state.sideToMove
  if (!legalMoves(state.board, side).includes(square)) return state

  const board = applyMove(state.board, side, square)
  return afterMove(board, side, square, state.humanSide)
}

/**
 * CPUの手番(`state.phase === 'cpu'`)であれば、エンジンに現在の盤面・手番・
 * 探索条件(`limit`)を問い合わせ、返ってきた最善手(`pv[0]`)を着手として適用する。
 *
 * `state.phase !== 'cpu'` の場合は何もせず同じ `state` を返す(呼び出し側は
 * `phase === 'cpu'` のときにだけ呼び出すことを想定)。
 */
export async function requestCpuMove(
  state: GameState,
  engine: EngineQuery,
  limit: AnalyzeLimit,
): Promise<GameState> {
  if (state.phase !== 'cpu') return state

  const response = await engine.requestAnalyze(state.board, state.sideToMove, limit)
  const bestMove = response.pv[0]
  if (bestMove === undefined) return state

  const square = notationToSquare(bestMove)
  return playMove(state, square)
}
