/**
 * 新旧盤面(`Board`)を比較し、「1手適用による通常の盤面遷移」かどうかを判定し、
 * 該当する場合は新規配置マス・反転マスの差分を導出する純粋関数(T066)。
 *
 * `Board.tsx`の石の反転アニメーションは、この差分を使ってどのマスをどう
 * 演出するか(新規出現/反転)を決める。新規対局開始・棋譜解析での別局面への
 * ジャンプ・分岐探索での局面切り替え・待った等の「1手適用によるものではない」
 * 盤面変化ではアニメーションさせず即座に最終状態を描画したいため、
 * その判定をコンポーネントから切り出し、vitestで決定的に検証できるようにする。
 *
 * # 判定方法
 *
 * 実際のオセロの1手適用(`game/othello.ts`の`applyMove`)は、
 * - 空きマスに新たに1つ石を置く(既存の石が消えることは無い)
 * - 挟まれた相手の石の色を反転させる(石自体は消えない)
 * という2つの操作のみで構成されるため、以下が両方とも成り立つ。
 * - 旧盤面で石があったマスは、新盤面でも必ず石がある(石が消えるマスが無い)
 * - 新盤面の総石数は、旧盤面の総石数からちょうど1だけ増える
 *
 * 逆に、新規対局・ジャンプ等ではこの2条件のいずれかが崩れる
 * (総石数が減る、+1以外の差になる、石があったマスが空に戻る等)ため、
 * この2条件を「1手適用による通常の遷移」の判定に用いる。
 * (パスのように盤面が全く変化しないケースは、総石数の差が+1にならないため
 * 「1手適用ではない」判定になるが、そもそも盤面が変化しないのでアニメーション
 * 対象が無く実害は無い。)
 */

import { countEmpty, type Board } from '../game/othello.ts'

export interface BoardDiff {
  /** 旧盤面から新盤面への変化が、「1手適用による通常の盤面遷移」だと判定できたか。 */
  isSingleMove: boolean
  /** 新たに石が置かれたマス(`isSingleMove`がfalseの場合は空配列)。 */
  placed: readonly number[]
  /** 色が反転したマス(`isSingleMove`がfalseの場合は空配列)。 */
  flipped: readonly number[]
}

const NO_DIFF: BoardDiff = { isSingleMove: false, placed: [], flipped: [] }

/** `prev`から`next`への変化を比較し、`BoardDiff`を返す。 */
export function diffBoards(prev: Board, next: Board): BoardDiff {
  const prevOccupied = prev.black | prev.white
  const nextOccupied = next.black | next.white

  // 旧盤面で石があったマスが、新盤面でも全て維持されているか
  // (=石が消えたマスが無いか)。
  const allPrevStillOccupied = (prevOccupied & nextOccupied) === prevOccupied

  const prevTotal = 64 - countEmpty(prev)
  const nextTotal = 64 - countEmpty(next)

  if (!allPrevStillOccupied || nextTotal !== prevTotal + 1) {
    return NO_DIFF
  }

  const placedMask = nextOccupied & ~prevOccupied
  const flippedMask = (prev.black & next.white) | (prev.white & next.black)

  return {
    isSingleMove: true,
    placed: maskToSquares(placedMask),
    flipped: maskToSquares(flippedMask),
  }
}

/** ビットマスクから、立っているビットに対応するマス番号の配列(昇順)を返す。 */
function maskToSquares(mask: bigint): number[] {
  const result: number[] = []
  let m = mask
  while (m !== 0n) {
    const lowest = m & -m
    const square = lowest.toString(2).length - 1
    result.push(square)
    m &= m - 1n
  }
  return result
}
