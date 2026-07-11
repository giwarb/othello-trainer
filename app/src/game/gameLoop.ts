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
  /**
   * 人間が担当する色。CPUは `opposite(humanSide)`。
   * `vsHuman: true` の対局(T077の2人対戦モード)では、どちらの色も人間が担当する
   * ため実質的に使われない(`phaseFor`は`vsHuman`が真なら`humanSide`を参照せず
   * 常に`'human'`を返す)が、`ResultCelebration`の演出種別判定等、既存の
   * `Side`型を要求するAPIとの互換性のために値自体は保持しておく
   * (`createGame`/`createGameFromPosition`呼び出し側が指定した値がそのまま入る)。
   */
  readonly humanSide: Side
  /**
   * 2人対戦モード(T077)かどうか。`true`の場合、`phaseFor`は常に`'human'`を返し、
   * CPU応手(`requestCpuMove`)は一切発生しない。
   */
  readonly vsHuman: boolean
  /** 直前の着手マス(初手前は `null`)。 */
  readonly lastMove: number | null
  readonly phase: GamePhase
  /** 直前の着手直後にパスが発生した場合の通知文言(発生していなければ `null`)。 */
  readonly passMessage: string | null
  /** 終局している場合の勝敗(終局していなければ `null`)。 */
  readonly result: GameResult | null
}

/** `createGame`/`createGameFromPosition` 共通のオプション(T077)。 */
export interface CreateGameOptions {
  /** `true` を指定すると2人対戦モード(CPU応手なし)で開始する。省略時は `false`。 */
  vsHuman?: boolean
}

/**
 * CPUの着手取得に必要な最小限のインターフェース。
 * T012の `EngineClient.requestAnalyze` はこれを満たすため、本番ではそのまま渡せる。
 * 単体テストでは `pv` フィールドだけを持つモックに差し替えられる。
 */
export interface EngineQuery {
  requestAnalyze(board: Board, turn: Side, limit: AnalyzeLimit): Promise<{ pv: readonly string[] }>
}

function phaseFor(side: Side, humanSide: Side, vsHuman: boolean): GamePhase {
  if (vsHuman) return 'human'
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

/**
 * 任意の開始局面(`board`/`sideToMove`)から `GameState` を組み立てる共通ヘルパー。
 *
 * 標準の初期局面(黒番、両者に合法手あり)であれば単に`phaseFor`の結果を
 * そのまま使えばよいが、T077で追加した盤面自由配置からの開始では、
 * 手番側に合法手が無い(異常な配置)開始局面もありうる。`afterMove`と同じ
 * パス/終局判定規則をこの初期局面にも適用することで、`playMove`が前提とする
 * 「`phase !== 'over'` なら `sideToMove` に必ず合法手がある」という不変条件を
 * 開始時点から保証する(やらないこと: 配置自体の合法性・到達可能性は検証しない)。
 */
function resolveInitialState(
  board: Board,
  sideToMove: Side,
  humanSide: Side,
  vsHuman: boolean,
): GameState {
  if (hasLegalMove(board, sideToMove)) {
    return {
      board,
      sideToMove,
      humanSide,
      vsHuman,
      lastMove: null,
      phase: phaseFor(sideToMove, humanSide, vsHuman),
      passMessage: null,
      result: null,
    }
  }

  const opponent = opposite(sideToMove)
  if (hasLegalMove(board, opponent)) {
    return {
      board,
      sideToMove: opponent,
      humanSide,
      vsHuman,
      lastMove: null,
      phase: phaseFor(opponent, humanSide, vsHuman),
      passMessage: `${sideLabel(sideToMove)}はパスしました`,
      result: null,
    }
  }

  return {
    board,
    sideToMove,
    humanSide,
    vsHuman,
    lastMove: null,
    phase: 'over',
    passMessage: null,
    result: decideResult(board),
  }
}

/**
 * 新規対局を開始する。オセロは常に黒番から始まる。`humanSide` は人間が担当する色。
 * `options.vsHuman`(T077)に`true`を指定すると2人対戦モードで開始する。
 */
export function createGame(humanSide: Side, options: CreateGameOptions = {}): GameState {
  return resolveInitialState(initialBoard(), 'black', humanSide, options.vsHuman ?? false)
}

/**
 * 任意の局面(盤面自由配置、T077)から対局を開始する。`board`/`sideToMove`は
 * 呼び出し側(`BoardEditor`)が組み立てた任意の配置・手番をそのまま受け取る
 * (配置の合法性・到達可能性は検証しない)。`humanSide`/`options.vsHuman`の
 * 意味は`createGame`と同じ。
 */
export function createGameFromPosition(
  board: Board,
  sideToMove: Side,
  humanSide: Side,
  options: CreateGameOptions = {},
): GameState {
  return resolveInitialState(board, sideToMove, humanSide, options.vsHuman ?? false)
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
function afterMove(
  board: Board,
  movedSide: Side,
  lastMove: number,
  humanSide: Side,
  vsHuman: boolean,
): GameState {
  const opponent = opposite(movedSide)

  if (hasLegalMove(board, opponent)) {
    return {
      board,
      sideToMove: opponent,
      humanSide,
      vsHuman,
      lastMove,
      phase: phaseFor(opponent, humanSide, vsHuman),
      passMessage: null,
      result: null,
    }
  }

  if (hasLegalMove(board, movedSide)) {
    return {
      board,
      sideToMove: movedSide,
      humanSide,
      vsHuman,
      lastMove,
      phase: phaseFor(movedSide, humanSide, vsHuman),
      passMessage: `${sideLabel(opponent)}はパスしました`,
      result: null,
    }
  }

  return {
    board,
    sideToMove: movedSide,
    humanSide,
    vsHuman,
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
  return afterMove(board, side, square, state.humanSide, state.vsHuman)
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
