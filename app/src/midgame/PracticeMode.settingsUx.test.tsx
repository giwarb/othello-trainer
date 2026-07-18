// @vitest-environment jsdom
/**
 * T137要件1・3のコンポーネントテスト: 中盤練習の設定画面・ステージ一覧の
 * 磨き込み。
 * 1. 判定モード等のチップに選択中の状態を示すクラスが付くこと(要件1)。
 * 2. 苦手パターンの空状態がアイコン+説明文になっていること(要件1)。
 * 3. ステージ一覧に「クリア x/N」サマリと進捗バー(aria-valuenow等)が
 *    表示され、クリア済みステージが増えると値が追従すること(要件3)。
 *
 * Board/エンジンは他の`midgame/PracticeMode.*.test.tsx`と同じ方針でモックする
 * (設定画面・ステージ一覧はいずれもエンジン呼び出しを伴わないため、
 * エンジンのモック自体は不要)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { PracticeMode } from './PracticeMode.tsx'
import { buildMidgameStagePool } from './stagePool.ts'
import { recordStageAttempt } from './stageProgress.ts'

vi.mock('../components/Board.tsx', () => ({
  Board: () => <button type="button" data-testid="stub-board" />,
}))

const LINES: RawJosekiLine[] = [
  { name: 'ライン1', aliases: [], moves: ['f5', 'f6'], firstMoveBasis: 'f5', depth: 2 },
  { name: 'ライン2', aliases: [], moves: ['f5', 'd6'], firstMoveBasis: 'f5', depth: 2 },
]
const JOSEKI_DB = buildJosekiDb(LINES)

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(JOSEKI_DB),
  lookupJosekiNode: () => null,
}))

async function flushAsyncEffects(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function findButton(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) => btn.textContent === text)
}

describe('T137要件1・3: 中盤練習の設定画面・ステージ一覧', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('判定モードチップの選択中に--activeクラスが付き、苦手パターンの空状態がアイコン付き説明文になっている', async () => {
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    // 苦手パターンの空状態(要件1、記録が無い状態)。
    const empty = container.querySelector('.midgame-pattern-stats__empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('失敗するとここに苦手パターンが貯まります')
    expect(empty?.querySelector('.midgame-pattern-stats__empty-icon')).not.toBeNull()

    // 既定値'strict'(`judgeModeStorage.ts`のDEFAULT_JUDGE_MODE)のチップだけが--activeになっている。
    const strictChip = Array.from(container.querySelectorAll<HTMLLabelElement>('.midgame-settings__option')).find(
      (label) => label.textContent?.includes('厳格'),
    )
    expect(strictChip?.classList.contains('midgame-settings__option--active')).toBe(true)
    const standardChip = Array.from(container.querySelectorAll<HTMLLabelElement>('.midgame-settings__option')).find(
      (label) => label.textContent?.includes('標準'),
    )
    expect(standardChip?.classList.contains('midgame-settings__option--active')).toBe(false)

    // クリックすると選択が切り替わる。
    const standardRadio = standardChip?.querySelector<HTMLInputElement>('input[type="radio"]')
    await act(async () => {
      standardRadio?.click()
    })
    expect(standardChip?.classList.contains('midgame-settings__option--active')).toBe(true)
    expect(strictChip?.classList.contains('midgame-settings__option--active')).toBe(false)

    // 「開始」が大きなプライマリCTAとして描画されている。
    const startButton = findButton(container, '開始')
    expect(startButton?.classList.contains('btn-primary')).toBe(true)
    expect(startButton?.classList.contains('midgame-settings__start-button')).toBe(true)
  })

  it('ステージ一覧に「クリア x/N」サマリと進捗バーが表示され、クリア済み数に応じて値が変わる', async () => {
    const stagePool = buildMidgameStagePool(JOSEKI_DB)
    expect(stagePool.length).toBe(2)

    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()

    await act(async () => {
      findButton(container, 'ステージ一覧')?.click()
    })
    await flushAsyncEffects()

    // クリア0件の状態。
    expect(container.querySelector('.midgame-stage-select__summary-text')?.textContent).toBe('クリア 0/2')
    const bar = container.querySelector('.midgame-stage-select__progress-bar')
    expect(bar?.getAttribute('aria-valuenow')).toBe('0')
    expect(bar?.getAttribute('aria-valuemax')).toBe('2')
    const fill = container.querySelector<HTMLDivElement>('.midgame-stage-select__progress-fill')
    expect(fill?.style.width).toBe('0%')

    // 1ステージを'standard'でクリア済みにしてから、コンポーネントを一度アンマウント
    // して再マウントする(`stageProgress`はマウント時の`useState`初期化子でのみ
    // `localStorage`から読み込まれるため、同一インスタンスへの再`render`では
    // 反映されない。実際のアプリでも記録直後は`setStageProgress`経由で更新される
    // ため、これは「別セッションで開き直した場合」を模したテスト)。
    recordStageAttempt(localStorage, stagePool[0]!.key, 'standard', 'clear')
    await act(async () => {
      render(null, container)
    })
    await act(async () => {
      render(<PracticeMode />, container)
    })
    await flushAsyncEffects()
    await act(async () => {
      findButton(container, 'ステージ一覧')?.click()
    })
    await flushAsyncEffects()

    expect(container.querySelector('.midgame-stage-select__summary-text')?.textContent).toBe('クリア 1/2')
    const barAfter = container.querySelector('.midgame-stage-select__progress-bar')
    expect(barAfter?.getAttribute('aria-valuenow')).toBe('1')
    const fillAfter = container.querySelector<HTMLDivElement>('.midgame-stage-select__progress-fill')
    expect(fillAfter?.style.width).toBe('50%')
  })
})
