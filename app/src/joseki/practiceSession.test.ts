import { describe, expect, it } from 'vitest'
import { advanceClearState } from './practiceSession.ts'

describe('advanceClearState', () => {
  it('isLeaf=falseでbookMovesが非空なら継続する(clearedLineNamesは変化しない)', () => {
    const result = advanceClearState([], {
      isLeaf: false,
      names: [],
      bookMoves: [{ move: 10, weight: 1 }],
    })
    expect(result.ended).toBe(false)
    expect(result.clearedLineNames).toEqual([])
  })

  it('isLeaf=trueでもbookMovesが非空なら継続する(短いラインの終端と長いラインの通過点が同居するケース)', () => {
    const result = advanceClearState([], {
      isLeaf: true,
      names: ['縦取り'],
      bookMoves: [{ move: 20, weight: 1 }],
    })
    expect(result.ended).toBe(false)
    // 継続はするが、通過したisLeafノードの名前は蓄積される。
    expect(result.clearedLineNames).toEqual(['縦取り'])
  })

  it('bookMovesが真に空になったら終了する(真の終端)', () => {
    const result = advanceClearState(['縦取り'], {
      isLeaf: true,
      names: ['虎'],
      bookMoves: [],
    })
    expect(result.ended).toBe(true)
    expect(result.clearedLineNames).toEqual(['縦取り', '虎'])
  })

  it('lookupがnull(定石DBに見つからない防御的ケース)なら終了扱いにする', () => {
    const result = advanceClearState(['縦取り'], null)
    expect(result.ended).toBe(true)
    expect(result.clearedLineNames).toEqual(['縦取り'])
  })

  it('複数のisLeafノードを通過すると、通過順に定石名が蓄積される(重複除去)', () => {
    let cleared: readonly string[] = []

    // 1つ目のisLeafノード(短いライン「縦取り」の終端、長いラインの通過点でもある)を通過。
    let step = advanceClearState(cleared, {
      isLeaf: true,
      names: ['縦取り', '虎'],
      bookMoves: [{ move: 1, weight: 1 }],
    })
    expect(step.ended).toBe(false)
    cleared = step.clearedLineNames
    expect(cleared).toEqual(['縦取り', '虎'])

    // isLeafでない中間ノードを通過(名前は増えない)。
    step = advanceClearState(cleared, { isLeaf: false, names: [], bookMoves: [{ move: 2, weight: 1 }] })
    cleared = step.clearedLineNames
    expect(cleared).toEqual(['縦取り', '虎'])

    // 2つ目のisLeafノード(「虎」は既出、新規に「猫」も含む)を通過し、bookMovesが空(真の終端)。
    step = advanceClearState(cleared, { isLeaf: true, names: ['虎', '猫'], bookMoves: [] })
    expect(step.ended).toBe(true)
    // 重複した「虎」は1つだけ、順序は初出順を維持。
    expect(step.clearedLineNames).toEqual(['縦取り', '虎', '猫'])
  })
})
