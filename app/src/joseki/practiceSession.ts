/**
 * 定石練習モード(T020)のセッション継続/終了判定ロジック(やり直し1回目で追加)。
 *
 * ## 発見された問題(オーケストレーターのフィードバック参照)
 * T017の`buildDb.ts`は「あるラインの終端ノード」と「別ラインの分岐点」が同一ノードに
 * なり得る設計(短い2手の定石(縦取り/斜め取り/並び取り)の終端が、虎・ローズ系等の
 * 18〜25手に及ぶ長い定石の通過点と一致する)。このため「`isLeaf`が`true`になったら
 * 即クリア」という単純なロジックでは、実データにおいて黒番プレイヤーが実質1手(f5)
 * しか打てないままクリアしてしまい、長い定石(全体の91%)を一度も辿れなかった。
 *
 * ## 修正後の仕様
 * - `isLeaf`が`true`でも、そのノードの`bookMoves`が非空であれば継続する
 *   (このノードは「短いラインの終端」であると同時に「長いラインの通過点」でもある)。
 * - `isLeaf`を通過するたびに、そのノードの`names`を「セッション内で通過した定石名」に
 *   蓄積する(重複除去)。
 * - `bookMoves`が真に空になった時点(その先に定石データが存在しない、本当の終端)で
 *   セッション終了。
 *
 * DOM/IndexedDB/エンジンへの依存を持たない純粋関数として実装し、`PracticeMode.tsx`の
 * 状態更新ロジック(`advance`)から呼び出す。単体テスト(`practiceSession.test.ts`)で
 * 「isLeafだがbookMoves非空なら継続」「bookMoves空で終了」「複数ライン名の蓄積」を検証する。
 */

/** `advanceClearState` が受け取る、着手後の局面についての定石DBルックアップ結果(部分型)。 */
export interface ClearLookupInput {
  readonly isLeaf: boolean
  readonly names: readonly string[]
  readonly bookMoves: readonly { readonly move: number; readonly weight: number }[]
}

export interface ClearAdvanceResult {
  /** 重複除去済みの、セッション開始からこの着手までに通過した`isLeaf`ノードの定石名の和集合。 */
  readonly clearedLineNames: readonly string[]
  /**
   * セッションが(この着手をもって)終了するかどうか。
   * `lookup`が`null`(定石DBに見つからない、通常発生しない防御的ケース)、または
   * `lookup.bookMoves`が空(その先に定石データが存在しない真の終端)であれば`true`。
   */
  readonly ended: boolean
}

/**
 * ある着手を適用した後の局面について、セッションを継続するか終了するかを判定し、
 * 「セッション内で通過した定石名」の集合を更新する。
 *
 * @param prevClearedLineNames これまでに蓄積済みの定石名(重複無し)。
 * @param lookup 着手後の局面に対する `lookupJosekiNode` の結果(見つからなければ`null`)。
 */
export function advanceClearState(
  prevClearedLineNames: readonly string[],
  lookup: ClearLookupInput | null,
): ClearAdvanceResult {
  let clearedLineNames = prevClearedLineNames

  if (lookup?.isLeaf) {
    const merged = new Set(prevClearedLineNames)
    for (const name of lookup.names) merged.add(name)
    clearedLineNames = [...merged]
  }

  const ended = (lookup?.bookMoves.length ?? 0) === 0

  return { clearedLineNames, ended }
}
