/**
 * 中盤練習「ステージ一覧」(T119)の問題集: 定石DB(`JosekiDb`)の全ラインの
 * 終端局面を、決定的な順序で列挙する。
 *
 * ## 設計方針(ユーザー裁定 2026-07-17: 案(a)採用)
 *
 * 事前生成の専用問題セット(案b)は作らず、既にビルド済みの定石DB
 * (`public/joseki.json`、`app/src/joseki/`)をそのまま列挙元にする。
 *
 * ## 列挙順序(要件1「定石DBの定義順」、redo #1: codex-review指摘(a)1の修正)
 *
 * `JosekiDb.lines`(`buildDb.ts`が`bookgen/joseki-research.json`の記載順で
 * そのまま構築する配列)を**定義順に走査**し、各ラインの終端局面
 * (`moveSeq`を初期局面から再生した局面)のハッシュを求める。初めて出現した
 * 終端の順序をそのままステージ順にし、以後同じ終端が現れても新しいステージは
 * 作らない(重複除去)。
 *
 * 旧実装(初回実装、redo前)は`JosekiDb.nodes`(`Map`)を`isLeaf===true`で
 * フィルタしたうえでキー文字列の辞書順にソートしていたが、これは「定義順」
 * という要件に反していた(局面ハッシュの辞書順はライン定義順と無関係)。
 * 重複除去される終端局面の**集合**自体は新旧どちらの実装でも同一
 * (`isLeaf===true`の`nodes`のキー集合 = 各ラインの終端ハッシュの集合、
 * という関係が`buildJosekiDb`の実装上常に成り立つため)なので、
 * **`MidgameStage.key`(localStorageの記録キー)には影響がない** —
 * 既存の進捗記録は本修正後もそのまま有効(`stagePool.test.ts`の
 * 「定義順修正後も要件1のステージ集合(キーの集合)は変わらない」テスト、
 * および`tasks/T119-midgame-stage-select.md`作業ログ参照)。変わるのは
 * 「どの順番で並ぶか(stageNumber)」と「各ステージにどのライン名が
 * 紐づくか(下記)」だけ。
 *
 * ## 出典ライン名(redo #1: codex-review指摘(a)2の修正)
 *
 * 各ステージの`josekiNames`には、**その局面を終端とするライン名だけ**を
 * 蓄積する。旧実装は`JosekiNode.names`(「この局面を**経由する**全ライン名」
 * ―`buildDb.ts`が`moveSeq`の各中間ノードにも`addName`するため、短いラインの
 * 終端が、たまたま別の長いラインの通過点と一致する場合に無関係な名前まで
 * 混入していた。111個の終端のうち29個がこのケースに該当し、最大で
 * 約80件の無関係な名前が混じっていた)を誤って使っていた。本実装は
 * `JosekiDb.nodes`を経由せず、`JosekiDb.lines`を1本ずつ走査して**そのライン
 * 自身の終端**に対してのみ名前を追加するため、この問題は構造的に起きない。
 *
 * ## 安定キー(要件1: 配列indexをキーにしない)
 *
 * ステージの識別子(`MidgameStage.key`)には、正規化済み局面ハッシュ
 * (`normalize.ts`の`hashBoard`の出力、`${blackHex}_${whiteHex}_${side}`形式)
 * をそのまま使う。`joseki:build`相当の再生成が起きても、同じ局面である限り
 * 同じキーになる(局面そのものが変わらない限り記録がズレない)。表示用の
 * 通し番号(`stageNumber`)は列挙結果内でのインデックス+1に過ぎず、
 * `localStorage`の記録キーには使わない。
 */

import { applyMove, initialBoard, opposite, type Board, type Side } from '../game/othello.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { JosekiDb } from '../joseki/types.ts'

/** 中盤練習ステージ1件。 */
export interface MidgameStage {
  /**
   * 安定キー(正規化済み局面ハッシュ、`normalize.ts`の`hashBoard`の出力形式)。
   * `localStorage`の進捗記録(`stageProgress.ts`)のキーとして使う。
   */
  readonly key: string
  /** 表示用の通し番号(1〜N、定石DBの定義順によって決まる。記録キーには使わない)。 */
  readonly stageNumber: number
  readonly board: Board
  readonly sideToMove: Side
  /** この局面を**終端とする**定石ライン名(合流時は複数。通過するだけのラインは含まない)。 */
  readonly josekiNames: readonly string[]
}

const HEX_PART_REGEX = /^[0-9a-f]+$/
const MASK64 = (1n << 64n) - 1n

/**
 * ステージキー(`hashBoard`の出力形式 `${blackHex}_${whiteHex}_${side}`)から
 * `Board`+`sideToMove`を復元する。
 *
 * redo #1(codex-review指摘(c)1): 形式チェックの後、16進数部分を`BigInt()`で
 * 直接パースすると不正な16進文字列(例: `"g1"`のような非16進文字を含む値)で
 * `SyntaxError`が送出され、本関数のドキュメント上の例外仕様(`RangeError`のみ)
 * と食い違っていた。16進文字のみで構成されているかを正規表現で事前検証し、
 * さらに64bit範囲・黒白ビットの重複も検証することで、**あらゆる不正入力に
 * 対して`RangeError`だけを投げる**よう修正した。
 *
 * @throws {RangeError} `key`が期待する形式でない場合(16進形式でない、
 *   64bit範囲を超える、黒白のビットが重複している等)。
 */
export function parseStageKey(key: string): { board: Board; sideToMove: Side } {
  const parts = key.split('_')
  if (parts.length !== 3) {
    throw new RangeError(`parseStageKey: invalid key format (expected 3 parts): ${key}`)
  }
  const [blackHex, whiteHex, side] = parts
  if (!blackHex || !whiteHex || !HEX_PART_REGEX.test(blackHex) || !HEX_PART_REGEX.test(whiteHex)) {
    throw new RangeError(`parseStageKey: invalid key format (expected lowercase hex): ${key}`)
  }
  if (side !== 'black' && side !== 'white') {
    throw new RangeError(`parseStageKey: invalid key format (unknown side): ${key}`)
  }

  const black = BigInt(`0x${blackHex}`)
  const white = BigInt(`0x${whiteHex}`)
  if (black > MASK64 || white > MASK64) {
    throw new RangeError(`parseStageKey: value out of 64-bit range: ${key}`)
  }
  if ((black & white) !== 0n) {
    throw new RangeError(`parseStageKey: black and white bits overlap: ${key}`)
  }

  return { board: { black, white }, sideToMove: side }
}

/** `line.moveSeq`(正規化済み着手列)を初期局面から再生し、終端の`Board`+`sideToMove`を求める。 */
function replayToEnd(moveSeq: readonly number[]): { board: Board; sideToMove: Side } {
  let board = initialBoard()
  let side: Side = 'black'
  for (const move of moveSeq) {
    board = applyMove(board, side, move)
    side = opposite(side)
  }
  return { board, sideToMove: side }
}

interface StageDraft {
  readonly key: string
  readonly board: Board
  readonly sideToMove: Side
  readonly josekiNames: string[]
}

/**
 * `josekiDb.lines`の全ラインの終端局面を、定義順(要件1)で列挙する。
 * 同一局面に複数ラインの終端が到達する場合は1エントリに集約し、
 * `josekiNames`にはその局面を終端とするライン名だけを集める
 * (redo #1、上記モジュールコメント参照)。
 *
 * 列挙結果が空、または極端に少ない場合でも例外は投げない(呼び出し側が
 * 空配列を見てUIで扱う。実データでは111件になることを確認済み、
 * `tasks/T119-midgame-stage-select.md`の作業ログ参照)。
 */
export function buildMidgameStagePool(josekiDb: JosekiDb): MidgameStage[] {
  const order: string[] = []
  const draftByKey = new Map<string, StageDraft>()

  for (const line of josekiDb.lines) {
    const { board, sideToMove } = replayToEnd(line.moveSeq)
    const key = hashBoard(board, sideToMove)

    let draft = draftByKey.get(key)
    if (!draft) {
      draft = { key, board, sideToMove, josekiNames: [] }
      draftByKey.set(key, draft)
      order.push(key)
    }
    if (!draft.josekiNames.includes(line.name)) {
      draft.josekiNames.push(line.name)
    }
  }

  return order.map((key, index) => {
    const draft = draftByKey.get(key)!
    return {
      key,
      stageNumber: index + 1,
      board: draft.board,
      sideToMove: draft.sideToMove,
      josekiNames: draft.josekiNames,
    }
  })
}
