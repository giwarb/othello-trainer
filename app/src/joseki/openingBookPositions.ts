/**
 * T151(拡張ブック生成 フェーズ2/2): 定石DB(`JosekiDb`)の全ノード・全合法手を
 * Edaxで評価するための下ごしらえ(局面収集)を行う純粋関数群。
 *
 * `JosekiDb.nodes` のキーは `normalize.ts` の `hashBoard()` が返す
 * `"<blackHex>_<whiteHex>_<side>"` 形式の文字列であり、`black`/`white` の
 * ビットボードをそのまま16進文字列化しているだけなので損失なく逆変換できる
 * (`parseNodeKey`)。ここではその特性を利用し、DAG構築時の手順を再シミュレート
 * せず、`nodes` を直接走査するだけで各ノードの実際の盤面を復元する。
 *
 * 各ノードについて `legalMoves`(bookMovesに限らず**全合法手**、要件1)を求め、
 * 着手後の局面を評価対象として収集する。着手後の局面は以下の3通りに分類する:
 *
 * 1. 着手後が終局(`isTerminal`): Edaxを呼ばず、確定した石差をそのまま
 *    `terminalValue`(元の手番視点)として埋め込む。
 * 2. 着手後、相手番に合法手がある(通常のケース): 相手番の局面をEdaxに
 *    評価させ、その結果を**符号反転**して元の手番視点の値にする
 *    (`needsFlip: true`)。
 * 3. 着手後、相手番に合法手が無く手番が元の側に戻る(パス):
 *    元の手番のままの局面をEdaxに評価させ、符号反転は不要
 *    (`needsFlip: false`)。
 *
 * (この3分類は `bench/edax-compare/vs_edax.py` の
 * `analyze_game_losses_v2`(T084、オラクルロス計算)と同じ考え方。)
 *
 * Edaxへの評価依頼(ケース2・3)は、着手後の局面(盤面+手番)が一致すれば
 * 同一の評価で済む(定石DAGは合流構造を持つため、複数ノード・複数手が
 * 同じ着手後局面に至ることがある)。`positionKey`(=着手後局面の
 * `hashBoard`)で重複排除し、Edax呼び出し回数を減らす。
 */

import {
  applyMove,
  countDiscs,
  hasLegalMove,
  isTerminal,
  legalMoves,
  opposite,
  type Board,
  type Side,
} from '../game/othello.ts'
import { hashBoard } from './normalize.ts'
import type { JosekiDb } from './types.ts'

/** 定石DBの局面ハッシュ(`hashBoard`の出力)を盤面+手番に逆変換する。 */
export function parseNodeKey(key: string): { board: Board; side: Side } {
  const parts = key.split('_')
  if (parts.length !== 3) {
    throw new RangeError(`parseNodeKey: unexpected key format "${key}"`)
  }
  const [blackHex, whiteHex, side] = parts
  if (side !== 'black' && side !== 'white') {
    throw new RangeError(`parseNodeKey: unexpected side "${side}" in key "${key}"`)
  }
  return {
    board: { black: BigInt(`0x${blackHex}`), white: BigInt(`0x${whiteHex}`) },
    side,
  }
}

/** `Board` をEdax/OBF形式の64文字盤面文字列(`X`=黒/`O`=白/`-`=空)に変換する。 */
export function boardToObf(board: Board): string {
  let out = ''
  for (let square = 0; square < 64; square++) {
    const bit = 1n << BigInt(square)
    if (board.black & bit) {
      out += 'X'
    } else if (board.white & bit) {
      out += 'O'
    } else {
      out += '-'
    }
  }
  return out
}

/** Edaxへの評価が必要な1局面(着手後局面、重複排除済み)。 */
export interface EvalPosition {
  /** `hashBoard(board, side)`(着手後局面のキー)。 */
  readonly key: string
  /** Edax/OBF形式の64文字盤面文字列。 */
  readonly board: string
  readonly side: Side
}

/** 1ノードの1合法手についての評価依頼。 */
export interface MoveEvalRequest {
  /** 評価対象の局面(着手前)を表す`JosekiDb.nodes`のキー。 */
  readonly nodeKey: string
  /** 正規化座標系での着手マス(0〜63)。 */
  readonly move: number
  /** 着手後が終局かどうか。 */
  readonly terminal: boolean
  /** `terminal: true` の場合のみ設定(元の手番視点の確定石差)。 */
  readonly terminalValue?: number
  /** `terminal: false` の場合のみ設定。`EvalPosition.key` を指す。 */
  readonly positionKey?: string
  /**
   * `terminal: false` の場合のみ設定。Edaxの評価結果(着手後局面の手番視点)を
   * 元の手番視点に変換する際、符号反転が必要かどうか
   * (相手番に手番が渡った通常のケースは`true`、相手がパスして手番が
   * 元の側に戻るケースは`false`)。
   */
  readonly needsFlip?: boolean
}

/** `collectMoveEvalRequests` の返り値。 */
export interface CollectedEvalRequests {
  readonly requests: readonly MoveEvalRequest[]
  readonly positions: readonly EvalPosition[]
}

/**
 * 定石DBの全ノード・全合法手についての評価依頼を収集する(要件1・2)。
 *
 * `requests`はノード×合法手の組(重複排除しない、全件)、`positions`は
 * Edaxに実際に投げる必要がある着手後局面(`positionKey`で重複排除済み)。
 */
export function collectMoveEvalRequests(db: JosekiDb): CollectedEvalRequests {
  const requests: MoveEvalRequest[] = []
  const positionsByKey = new Map<string, EvalPosition>()

  for (const nodeKey of db.nodes.keys()) {
    const { board, side } = parseNodeKey(nodeKey)
    const opponent = opposite(side)

    for (const move of legalMoves(board, side)) {
      const after = applyMove(board, side, move)

      if (isTerminal(after)) {
        const terminalValue = countDiscs(after, side) - countDiscs(after, opponent)
        requests.push({ nodeKey, move, terminal: true, terminalValue })
        continue
      }

      const effectiveSide: Side = hasLegalMove(after, opponent) ? opponent : side
      const needsFlip = effectiveSide !== side
      const positionKey = hashBoard(after, effectiveSide)

      if (!positionsByKey.has(positionKey)) {
        positionsByKey.set(positionKey, {
          key: positionKey,
          board: boardToObf(after),
          side: effectiveSide,
        })
      }

      requests.push({ nodeKey, move, terminal: false, positionKey, needsFlip })
    }
  }

  return { requests, positions: [...positionsByKey.values()] }
}
