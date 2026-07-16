/**
 * 中盤練習「ステージ一覧」(T119)の問題集: 定石DB(`JosekiDb`)の全ラインの
 * 終端局面を、決定的な順序で列挙する。
 *
 * ## 設計方針(ユーザー裁定 2026-07-17: 案(a)採用)
 *
 * 事前生成の専用問題セット(案b)は作らず、既にビルド済みの定石DB
 * (`public/joseki.json`、`app/src/joseki/`)をそのまま列挙元にする。
 *
 * `JosekiNode.isLeaf`(`app/src/joseki/types.ts`)は「この局面がいずれかの
 * 定石ラインの最終局面であれば true」と定義されている(`buildDb.ts`の
 * `buildJosekiDb`が各ラインの最終局面に対して明示的にこのフラグを立てる)。
 * したがって `JosekiDb.nodes` を `isLeaf === true` でフィルタするだけで、
 * 「全ラインの終端局面」の集合が過不足なく得られる。しかも `nodes` の
 * キー自体が正規化済み局面の一意なハッシュ(`normalize.ts`の`hashBoard`の
 * 出力、`${blackHex}_${whiteHex}_${side}`形式)であるため、複数ラインが
 * 同じ終端局面に合流する場合も自動的に1エントリへ集約されている
 * (`buildJosekiDb`のノード構築が`getOrCreateNode`でMap合流させるため)。
 * → 要件1の「重複除去」は追加実装なしで満たされる。
 *
 * ## 安定キー(要件1: 配列indexをキーにしない)
 *
 * ステージの識別子(`MidgameStage.key`)には、この正規化済み局面ハッシュを
 * そのまま使う。`puzzles:build`相当の再生成(`joseki:build`)が起きても、
 * 同じ局面である限り同じキーになる(局面そのものが変わらない限り記録が
 * ズレない)。表示用の通し番号(`stageNumber`)は毎回の列挙結果内での
 * インデックス+1に過ぎず、`localStorage`の記録キーには使わない。
 *
 * ## 決定的な順序
 *
 * `Map`の反復順は挿入順(=ビルド時のライン処理順)に依存するが、
 * JSON往復(`serializeJosekiDb`/`deserializeJosekiDb`)を経てもJS仕様上は
 * 保持されるものの、暗黙の仕様依存になり脆い。本モジュールは
 * `isLeaf`フィルタ後にキー文字列の辞書順(`<`演算子、ロケール非依存)で
 * 明示的にソートすることで、挿入順に依存しない決定性を保証する
 * (`stagePool.test.ts`の決定性テスト参照)。
 */

import type { Board, Side } from '../game/othello.ts'
import type { JosekiDb, JosekiNode } from '../joseki/types.ts'

/** 中盤練習ステージ1件。 */
export interface MidgameStage {
  /**
   * 安定キー(正規化済み局面ハッシュ、`normalize.ts`の`hashBoard`の出力形式)。
   * `localStorage`の進捗記録(`stageProgress.ts`)のキーとして使う。
   */
  readonly key: string
  /** 表示用の通し番号(1〜N、列挙順によって決まる。記録キーには使わない)。 */
  readonly stageNumber: number
  readonly board: Board
  readonly sideToMove: Side
  /** この局面を経由する定石ライン名(合流時は複数、`JosekiNode.names`のコピー)。 */
  readonly josekiNames: readonly string[]
}

/**
 * ステージキー(`hashBoard`の出力形式 `${blackHex}_${whiteHex}_${side}`)から
 * `Board`+`sideToMove`を復元する。`moveSeq`を初期局面から再生する必要が
 * 無く、キー文字列自体に局面情報が全て含まれている(`normalize.ts`の
 * `hashBoard`実装参照)。
 *
 * @throws {RangeError} `key`が期待する形式でない場合。
 */
export function parseStageKey(key: string): { board: Board; sideToMove: Side } {
  const parts = key.split('_')
  if (parts.length !== 3) {
    throw new RangeError(`parseStageKey: invalid key format (expected 3 parts): ${key}`)
  }
  const [blackHex, whiteHex, side] = parts
  if (!blackHex || !whiteHex || (side !== 'black' && side !== 'white')) {
    throw new RangeError(`parseStageKey: invalid key format: ${key}`)
  }
  return {
    board: { black: BigInt(`0x${blackHex}`), white: BigInt(`0x${whiteHex}`) },
    sideToMove: side,
  }
}

/**
 * `josekiDb`の全ラインの終端局面を、決定的な順序(ステージキーの辞書順)で
 * 列挙する(要件1)。同一局面に複数ラインから到達する場合は`JosekiDb.nodes`
 * の時点で既に集約されているため、追加の重複除去は不要。
 *
 * 列挙結果が空、または極端に少ない場合でも例外は投げない(呼び出し側が
 * 空配列を見てUIで扱う。実データでは111件になることを確認済み、
 * `tasks/T119-midgame-stage-select.md`の作業ログ参照)。
 */
export function buildMidgameStagePool(josekiDb: JosekiDb): MidgameStage[] {
  const leafEntries: [string, JosekiNode][] = []
  for (const entry of josekiDb.nodes) {
    if (entry[1].isLeaf) leafEntries.push(entry)
  }
  leafEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return leafEntries.map(([key, node], index) => {
    const { board, sideToMove } = parseStageKey(key)
    return {
      key,
      stageNumber: index + 1,
      board,
      sideToMove,
      josekiNames: [...node.names],
    }
  })
}
