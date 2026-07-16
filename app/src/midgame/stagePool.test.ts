import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyMove, initialBoard, notationToSquare, opposite, type Side } from '../game/othello.ts'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import { hashBoard } from '../joseki/normalize.ts'
import type { RawJosekiFile, RawJosekiLine } from '../joseki/types.ts'
import { buildMidgameStagePool, parseStageKey } from './stagePool.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAW_JOSEKI_PATH = path.resolve(__dirname, '../../../bookgen/joseki-research.json')

/** `buildDb.test.ts`と同じ手法: 実データ(`bookgen/joseki-research.json`)を読み込む。 */
function loadRealRawLines(): readonly RawJosekiLine[] {
  const raw = JSON.parse(readFileSync(RAW_JOSEKI_PATH, 'utf-8')) as RawJosekiFile
  return raw.lines
}

function makeLine(name: string, moves: readonly string[], depth = moves.length): RawJosekiLine {
  return { name, aliases: [], moves, firstMoveBasis: 'f5', depth }
}

describe('buildMidgameStagePool', () => {
  it('実データ(bookgen/joseki-research.json)から決定的にステージを列挙できる(要件1・3)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    // 実データのライン数(112件)に対し、終端局面の重複除去後は111件になる
    // ことを確認済み(作業ログ参照)。bookgen/joseki-research.jsonの内容が
    // 将来更新された場合はこの数値も見直すこと。
    expect(rawLines.length).toBe(112)
    expect(stages.length).toBe(111)
  })

  it('2回列挙しても同一の結果になる(決定性、要件6)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)

    const first = buildMidgameStagePool(db)
    const second = buildMidgameStagePool(db)

    expect(second).toEqual(first)
    expect(first.map((s) => s.key)).toEqual(second.map((s) => s.key))
  })

  /**
   * redo #1(codex-review指摘(a)1): 修正前の実装はハッシュ辞書順でソートして
   * いたため、ライン順序を反転させても列挙結果が変わらない(=仕様「定石DBの
   * 定義順」と逆の挙動)ことをテストで固定してしまっていた。正しい仕様は
   * 「`JosekiDb.lines`の定義順に追従する」ことなので、ライン順序を変えれば
   * 列挙順序も追従して変わることを検証する(ステージの**集合**(キーの集合)
   * 自体は変わらないことも合わせて確認する)。
   */
  it('ライン順序を変えると列挙順序も追従する(定石DBの定義順に従うこと、要件1)', () => {
    const rawLines = loadRealRawLines()
    const dbForward = buildJosekiDb(rawLines)
    const dbReversed = buildJosekiDb([...rawLines].reverse())

    const stagesForward = buildMidgameStagePool(dbForward)
    const stagesReversed = buildMidgameStagePool(dbReversed)

    // ステージの集合(重複除去後の終端局面のキー集合)自体は順序によらず同じ
    // (`localStorage`の記録キーに影響しないことの確認、作業ログにも記載)。
    expect(new Set(stagesForward.map((s) => s.key))).toEqual(new Set(stagesReversed.map((s) => s.key)))
    expect(stagesForward).toHaveLength(stagesReversed.length)

    // しかし並び順(定義順)は逆になっているはずなので、通常は先頭ステージが
    // 入れ替わる(実データで確認済み)。
    expect(stagesForward.map((s) => s.key)).not.toEqual(stagesReversed.map((s) => s.key))
    expect(stagesForward[0]!.key).not.toBe(stagesReversed[0]!.key)
  })

  /**
   * redo #1(codex-review指摘(a)1): 「定義順」を、実装の内部詳細を再現するの
   * ではなく仕様の定義そのもの(`JosekiDb.lines`を順に見て、各ラインの終端の
   * 初出順)から独立に計算した期待値と突き合わせることで検証する。
   */
  it('ステージ順序は定石DBの定義順(JosekiDb.linesの初出順)と一致する(要件1)', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    const expectedOrderKeys: string[] = []
    const seen = new Set<string>()
    for (const line of db.lines) {
      let board = initialBoard()
      let side: Side = 'black'
      for (const move of line.moveSeq) {
        board = applyMove(board, side, move)
        side = opposite(side)
      }
      const key = hashBoard(board, side)
      if (!seen.has(key)) {
        seen.add(key)
        expectedOrderKeys.push(key)
      }
    }

    expect(stages.map((s) => s.key)).toEqual(expectedOrderKeys)
  })

  it('stageNumberは1始まりの連番で、配列の並び順と一致する', () => {
    const rawLines = loadRealRawLines()
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    stages.forEach((stage, index) => {
      expect(stage.stageNumber).toBe(index + 1)
    })
  })

  it('同一終端局面に到達する2ラインは1ステージに重複除去され、josekiNamesに両方の名前が入る(要件1)', () => {
    // "小定石A"(f5,f6)と"小定石B"(f5,f6,e6,f4)は前者が後者の途中に
    // 一致するわけではなく、ここでは同一の最終局面に別ラインから到達する
    // ケースとして、同じmoveSeqを持つ2つのラインを用意する(名前だけ異なる)。
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6']), makeLine('定石B', ['f5', 'f6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    expect(stages).toHaveLength(1)
    expect(stages[0]!.josekiNames).toEqual(['定石A', '定石B'])
  })

  /**
   * redo #1(codex-review指摘(a)2): `josekiNames`には、その局面を**終端とする**
   * ラインの名前だけが入るべきで、途中で通過するだけの(より長い)ラインの
   * 名前が混入してはならない。「短いライン」の終端(f5,f6を打った局面)を
   * 「長いライン」が経由してさらに先(e6,f4)まで進む構成で検証する。
   */
  it('josekiNamesには、その局面を終端とするラインの名前のみが含まれる(通過するだけのラインは含まれない、要件1)', () => {
    const rawLines: RawJosekiLine[] = [
      makeLine('短いライン', ['f5', 'f6']),
      makeLine('長いライン', ['f5', 'f6', 'e6', 'f4']),
    ]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    // 「短いライン」の終端(2手目)と「長いライン」の終端(4手目)は異なる局面
    // なので、2ステージになる。
    expect(stages).toHaveLength(2)

    const shortStage = stages.find((s) => s.josekiNames.includes('短いライン'))
    expect(shortStage).toBeDefined()
    // 「長いライン」はこの局面を通過するだけ(終端ではない)なので含まれない。
    expect(shortStage!.josekiNames).toEqual(['短いライン'])

    const longStage = stages.find((s) => s.josekiNames.includes('長いライン'))
    expect(longStage).toBeDefined()
    expect(longStage!.josekiNames).toEqual(['長いライン'])
  })

  it('異なる終端局面を持つラインはそれぞれ別ステージになる', () => {
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6']), makeLine('定石C', ['f5', 'd6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)

    expect(stages).toHaveLength(2)
    const keys = new Set(stages.map((s) => s.key))
    expect(keys.size).toBe(2)
  })

  it('列挙されたboard/sideToMoveが、実際にmoveSeqを再生した局面と一致する', () => {
    const rawLines: RawJosekiLine[] = [makeLine('定石A', ['f5', 'f6', 'e6'])]
    const db = buildJosekiDb(rawLines)
    const stages = buildMidgameStagePool(db)
    expect(stages).toHaveLength(1)

    // 期待値: 初期局面からf5,f6,e6を順に適用した局面(正規化変換はf5始まりのため恒等変換)。
    let expectedBoard = initialBoard()
    let expectedSide: Side = 'black'
    for (const notation of ['f5', 'f6', 'e6']) {
      expectedBoard = applyMove(expectedBoard, expectedSide, notationToSquare(notation))
      expectedSide = opposite(expectedSide)
    }

    expect(stages[0]!.board).toEqual(expectedBoard)
    expect(stages[0]!.sideToMove).toBe(expectedSide)
    expect(stages[0]!.key).toBe(hashBoard(expectedBoard, expectedSide))
  })
})

describe('parseStageKey', () => {
  it('hashBoardの出力を往復できる(round-trip)', () => {
    let board = initialBoard()
    let side: Side = 'black'
    board = applyMove(board, side, notationToSquare('f5'))
    side = opposite(side)

    const key = hashBoard(board, side)
    const parsed = parseStageKey(key)

    expect(parsed.board).toEqual(board)
    expect(parsed.sideToMove).toBe(side)
  })

  it('形式が不正なキーは例外を投げる', () => {
    expect(() => parseStageKey('invalid')).toThrow(RangeError)
    expect(() => parseStageKey('abc_def_purple')).toThrow(RangeError)
    expect(() => parseStageKey('abc_def')).toThrow(RangeError)
  })

  /**
   * redo #1(codex-review指摘(c)1): 16進数部分が不正な文字列の場合、修正前は
   * `BigInt()`が`SyntaxError`を投げてしまい、本関数のドキュメント上の例外仕様
   * (`RangeError`のみ)と食い違っていた。あらゆる不正入力に対して`RangeError`
   * だけが投げられることを検証する。
   */
  it('16進数として不正な文字を含む場合もSyntaxErrorではなくRangeErrorを投げる', () => {
    expect(() => parseStageKey('ghij_klmn_black')).toThrow(RangeError)
    expect(() => parseStageKey('0xz1_0x2_black')).toThrow(RangeError)
    expect(() => parseStageKey('_1_black')).toThrow(RangeError)
  })

  it('64bit範囲を超える値はRangeErrorを投げる', () => {
    // 65bit分の1(2^64)は64bitに収まらない。
    expect(() => parseStageKey('10000000000000000_0_black')).toThrow(RangeError)
  })

  it('黒白のビットが重複している場合はRangeErrorを投げる', () => {
    expect(() => parseStageKey('1_1_black')).toThrow(RangeError)
  })
})
