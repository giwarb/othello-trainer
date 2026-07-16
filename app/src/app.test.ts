import { describe, expect, it } from 'vitest'
import { cpuMoveLimitForLevel, ENDGAME_UNLIMITED_EMPTIES_THRESHOLD, LEVELS } from './app.tsx'
import { createBoard, initialBoard } from './game/othello.ts'

// T116: 空き20以下は`board`によらず固定閾値(`ENDGAME_UNLIMITED_EMPTIES_THRESHOLD`)を
// 使う設計なので、テストでも実際の空きマス数を`createBoard`で作り込んで検証する
// (`countEmpty` = 64 - 石の総数)。
function boardWithEmpties(empties: number): ReturnType<typeof createBoard> {
  const stoneCount = 64 - empties
  // 合法性は問わず、石の総数だけを制御できればよい(空きマス数の計算にしか使わない)。
  const blackSquares = Array.from({ length: stoneCount }, (_, i) => i)
  return createBoard(blackSquares, [])
}

describe('CPU strength presets (T085c, T116)', () => {
  it('applies the calibrated node budget only to strong CPU moves away from the endgame', () => {
    const midgameBoard = boardWithEmpties(30)
    expect(cpuMoveLimitForLevel('weak', midgameBoard)).toEqual({ depth: 4, exactFromEmpties: 8 })
    expect(cpuMoveLimitForLevel('normal', midgameBoard)).toEqual({ depth: 8, exactFromEmpties: 12 })
    expect(cpuMoveLimitForLevel('strong', midgameBoard)).toEqual({
      depth: 12,
      timeMs: 1500,
      maxNodes: 160000,
      exactFromEmpties: 16,
    })
  })

  it('keeps strong all-moves and display analysis on the legacy limit', () => {
    expect(LEVELS.strong.limit).toEqual({ depth: 12, exactFromEmpties: 16 })
  })

  it('switches strong CPU moves to an unbounded exact-solve limit at the endgame threshold (empties<=20)', () => {
    const atThreshold = boardWithEmpties(ENDGAME_UNLIMITED_EMPTIES_THRESHOLD)
    expect(cpuMoveLimitForLevel('strong', atThreshold)).toEqual({
      depth: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
      exactFromEmpties: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
    })

    const deeper = boardWithEmpties(1)
    expect(cpuMoveLimitForLevel('strong', deeper)).toEqual({
      depth: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
      exactFromEmpties: ENDGAME_UNLIMITED_EMPTIES_THRESHOLD,
    })
  })

  it('keeps the current node-budget cpuLimit unchanged one move above the threshold (empties=21)', () => {
    const justAbove = boardWithEmpties(ENDGAME_UNLIMITED_EMPTIES_THRESHOLD + 1)
    expect(cpuMoveLimitForLevel('strong', justAbove)).toEqual({
      depth: 12,
      timeMs: 1500,
      maxNodes: 160000,
      exactFromEmpties: 16,
    })
  })

  it('never switches weak/normal to the unlimited exact-solve limit even deep in the endgame', () => {
    const deepBoard = boardWithEmpties(5)
    expect(cpuMoveLimitForLevel('weak', deepBoard)).toEqual({ depth: 4, exactFromEmpties: 8 })
    expect(cpuMoveLimitForLevel('normal', deepBoard)).toEqual({ depth: 8, exactFromEmpties: 12 })
  })

  it('ignores the board for weak/normal (initial board has 60 empties, above any threshold)', () => {
    expect(cpuMoveLimitForLevel('weak', initialBoard())).toEqual({ depth: 4, exactFromEmpties: 8 })
  })
})
