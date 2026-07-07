/**
 * 現局面が定石DB(`JosekiDb`)内にあるかどうかを調べるルックアップヘルパー(T019)。
 *
 * T017の定石DBは、全ラインを「初手をf5とみなす」正規化
 * (`normalize.ts` の `opForFirstMove`/`normalizeBoard`)を適用した上で
 * 構築されている(`buildDb.ts`)。したがって実際の対局中の局面をDBに
 * 問い合わせる際も、その対局の実際の初手(`d3`/`c4`/`f5`/`e6` のいずれか)
 * に対応する変換を毎回適用してから `hashBoard` でキーを引く必要がある。
 *
 * 加えて、`public/joseki.json`(T017でビルド済みの `SerializedJosekiDb`)を
 * fetchして `JosekiDb` に復元する `loadJosekiDb` も提供する。初回のみ
 * fetchし、以降は同じ `Promise` をキャッシュして返す。
 */

import { deserializeJosekiDb } from './buildDb.ts'
import { denormalizeSquare, hashBoard, normalizeBoard, opForFirstMove } from './normalize.ts'
import type { JosekiDb, JosekiNode, SerializedJosekiDb } from './types.ts'
import type { Board, Side } from '../game/othello.ts'

/** 定石DBの候補手を、実際の盤面座標(逆正規化済み)で表したもの。 */
export interface JosekiBookMoveView {
  /** 実際の盤面座標での着手マス(0〜63)。 */
  readonly move: number
  readonly weight: number
}

/** `lookupJosekiNode` の結果。 */
export interface JosekiLookupResult {
  /** 元の(正規化座標系の)ノード。 */
  readonly node: JosekiNode
  /** いずれかの定石ラインの最終局面であれば `true`(=これ以上定石が続かない)。 */
  readonly isLeaf: boolean
  /** この局面を経由する定石ライン名。 */
  readonly names: readonly string[]
  /** 実際の盤面座標に逆正規化した候補手一覧。 */
  readonly bookMoves: readonly JosekiBookMoveView[]
}

/**
 * 現局面(`board`, `sideToMove`)が定石DBに登録されているか調べる。
 *
 * `firstMoveSquare` には、その対局で実際に指された初手のマス
 * (`d3`/`c4`/`f5`/`e6` のいずれか。黒が最初に指す手)を渡す。まだ1手も
 * 指されていない初期局面を調べる場合は、任意の合法初手(例えば
 * `notationToSquare('f5')`)を渡してよい(初期局面は4つの変換いずれでも
 * 不動点のため、結果は変わらない)。
 *
 * 登録が無ければ `null` を返す。
 */
export function lookupJosekiNode(
  db: JosekiDb,
  board: Board,
  sideToMove: Side,
  firstMoveSquare: number,
): JosekiLookupResult | null {
  const op = opForFirstMove(firstMoveSquare)
  const normalized = normalizeBoard(board, op)
  const key = hashBoard(normalized, sideToMove)
  const node = db.nodes.get(key)
  if (!node) return null

  const bookMoves = node.bookMoves.map((bookMove) => ({
    move: denormalizeSquare(bookMove.move, op),
    weight: bookMove.weight,
  }))

  return { node, isLeaf: node.isLeaf, names: node.names, bookMoves }
}

let cachedDb: Promise<JosekiDb> | null = null

/**
 * `public/joseki.json` をfetchして `JosekiDb` として読み込む。
 * 初回のみfetchし、以降は同じ `Promise` をキャッシュして返す(複数箇所
 * から呼ばれてもfetchは1回だけ発生する)。
 *
 * `fetchImpl`/`basePath` はテスト用の差し替え口(本番はグローバルの
 * `fetch` と Viteが注入する `import.meta.env.BASE_URL` をそのまま使う。
 * GitHub Pagesのサブパス配信 `vite.config.ts` 参照)。
 */
export function loadJosekiDb(
  fetchImpl: typeof fetch = fetch,
  basePath: string = import.meta.env.BASE_URL,
): Promise<JosekiDb> {
  if (!cachedDb) {
    cachedDb = fetchImpl(`${basePath}joseki.json`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`failed to fetch joseki.json: ${res.status}`)
        }
        return res.json()
      })
      .then((data) => deserializeJosekiDb(data as SerializedJosekiDb))
      .catch((error: unknown) => {
        // 失敗時は次回呼び出しで再fetchできるよう、キャッシュに失敗した
        // Promiseを残さない。
        cachedDb = null
        throw error instanceof Error ? error : new Error(String(error))
      })
  }
  return cachedDb
}

/** テスト専用: `loadJosekiDb` のキャッシュをリセットする。 */
export function resetJosekiDbCacheForTest(): void {
  cachedDb = null
}
