// @vitest-environment jsdom
/**
 * T130(T141で★制の新スキーマ・語彙向けに改訂): 中盤練習ステージ一覧の復習
 * フィルタ(すべて/未挑戦/失敗あり/未クリア(★0)/クリア済み(★1+))が
 * `localStorage`の挑戦記録(`stageProgress.ts`、T141のフラット★スキーマ)どおりに
 * 絞り込まれること、選択が`localStorage`へ永続化されることを検証する。
 *
 * T141で判定モード選択UI自体が廃止されたため、旧要件2(判定モード切り替えへの
 * フィルタ追従)は対象外(モードという概念が無くなったため、`tasks/T141-*.md`
 * 要件6「判定モード切替への追従は廃止」)。
 *
 * 4件の合成定石ラインからステージプールを構築し、各ステージのキーへ既知の
 * 進捗を事前投入する。ライン構成・正規化の注意点は旧テストと同じ(`opForFirstMove`
 * により初手だけが異なるラインは同一局面に収束するため、全ラインが同じ初手(f5)を
 * 共有し2手目以降で区別する)。
 * モック方針は`PracticeMode.staleSession.test.tsx`と同じ(Board/engineをスタブ化、
 * `loadJosekiDb`を合成DBに差し替え。対局は行わずステージ一覧画面のみを操作する)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_REVIEW_FILTER_STORAGE_KEY } from '../settings/reviewFilter.ts'
import { buildMidgameStagePool } from './stagePool.ts'
import { MIDGAME_STAGE_STARS_STORAGE_KEY, type StageProgress } from './stageProgress.ts'

vi.mock('../components/Board.tsx', () => ({
  Board: () => (
    <button type="button" data-testid="stub-board">
      board
    </button>
  ),
}))

function line(name: string, moves: readonly string[]): RawJosekiLine {
  return { name, aliases: [], moves, firstMoveBasis: moves[0]!, depth: moves.length }
}

// 全ライン共通の初手f5から分岐する、互いに合流しない4手順
// (ステージ1〜4に対応する定義順で並べる)。
const SYNTHETIC_LINES: RawJosekiLine[] = [
  line('ステージA用ライン', ['f5', 'f4']),
  line('ステージB用ライン', ['f5', 'd6']),
  line('ステージC用ライン', ['f5', 'f6']),
  line('ステージD用ライン', ['f5', 'f4', 'c3']),
]

const SYNTHETIC_DB = buildJosekiDb(SYNTHETIC_LINES)
const SYNTHETIC_STAGE_POOL = buildMidgameStagePool(SYNTHETIC_DB)

function keyForLine(name: string): string {
  const stage = SYNTHETIC_STAGE_POOL.find((s) => s.josekiNames.includes(name))
  if (!stage) throw new Error(`test setup error: stage not found for line "${name}"`)
  return stage.key
}

vi.mock('../joseki/lookup.ts', () => ({
  loadJosekiDb: () => Promise.resolve(SYNTHETIC_DB),
  lookupJosekiNode: () => null,
}))

vi.mock('../engine/sharedClient.ts', () => ({
  getSharedEngineClient: () => ({
    requestAnalyzeAll: () => Promise.reject(new Error('T130テストでは使用しない')),
    requestAnalyze: () => Promise.reject(new Error('T130テストでは使用しない')),
    requestFeatureSet: () => Promise.reject(new Error('T130テストでは使用しない')),
    requestEvalTerms: () => Promise.reject(new Error('T130テストでは使用しない')),
    terminate: () => {},
  }),
}))

const NOW = '2026-07-19T00:00:00.000Z'

/**
 * ステージA〜D(定義順でstageNumber1〜4)に、フィルタ挙動を検証するための
 * 挑戦記録(T141フラット★スキーマ):
 * - A: 記録なし -> 未挑戦。
 * - B: ★0で1回失敗(クリアなし) -> 挑戦済み未クリア・失敗あり。
 * - C: ★2でクリア(失敗なし) -> クリア済み・失敗なし。
 * - D: ★0で2回失敗した後、★1でクリア -> クリア済み・失敗あり(要件「失敗あり」は
 *   現在の状態を問わない累積の失敗経験そのものを指す、`failCount`フィールド参照)。
 */
function makeProgress(): StageProgress {
  const keyB = keyForLine('ステージB用ライン')
  const keyC = keyForLine('ステージC用ライン')
  const keyD = keyForLine('ステージD用ライン')
  return {
    [keyB]: { bestStars: 0, attempts: 1, failCount: 1, lastResultStars: 0, lastAttemptAt: NOW, firstClearedAt: null },
    [keyC]: { bestStars: 2, attempts: 1, failCount: 0, lastResultStars: 2, lastAttemptAt: NOW, firstClearedAt: NOW },
    [keyD]: { bestStars: 1, attempts: 3, failCount: 2, lastResultStars: 1, lastAttemptAt: NOW, firstClearedAt: NOW },
  }
}

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** ステージ一覧(T141: 初期画面そのもの)が表示されるまで進める共通手順。 */
async function enterStageSelect(container: HTMLDivElement): Promise<void> {
  const { PracticeMode } = await import('./PracticeMode.tsx')
  await act(async () => {
    render(<PracticeMode />, container)
  })
  await flushAsyncEffects()

  expect(container.querySelector('.midgame-stage-select')).not.toBeNull()
}

function clickFilter(container: HTMLDivElement, label: string): void {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.midgame-stage-select__filter-button'),
  ).find((btn) => btn.textContent === label)
  expect(button).toBeDefined()
  button?.click()
}

function gridNumbers(container: HTMLDivElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.midgame-stage-grid__number'))
    .map((el) => el.textContent ?? '')
    .sort()
}

describe('T130/T141: 中盤練習ステージ一覧の復習フィルタ(★制)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(MIDGAME_STAGE_STARS_STORAGE_KEY, JSON.stringify(makeProgress()))
    // 移行ロジック(旧記録からのシード)を起動時に一度スキップさせる(旧記録が
    // 無いため実質何もしないが、明示的にマーカーを立てて安全側にする)。
    localStorage.setItem('othello-trainer:midgame-stage-stars-migrated', '1')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('フィルタ5種それぞれの表示ステージ番号が記録どおりになる(要件6の新語彙で操作)', async () => {
    await enterStageSelect(container)

    // 既定は「すべて」: 4ステージすべて表示。
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])

    await act(async () => clickFilter(container, '未挑戦'))
    expect(gridNumbers(container)).toEqual(['1'])

    await act(async () => clickFilter(container, '失敗あり'))
    expect(gridNumbers(container)).toEqual(['2', '4'])

    await act(async () => clickFilter(container, '未クリア(★0)'))
    expect(gridNumbers(container)).toEqual(['1', '2'])

    await act(async () => clickFilter(container, 'クリア済み(★1+)'))
    expect(gridNumbers(container)).toEqual(['3', '4'])

    await act(async () => clickFilter(container, 'すべて'))
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])
  })

  it('該当0件のとき、グリッドの代わりに空表示メッセージを出す', async () => {
    // 全ステージが「失敗あり」ではない状態を作る(B・Dの記録を消す)。
    localStorage.setItem(
      MIDGAME_STAGE_STARS_STORAGE_KEY,
      JSON.stringify({ [keyForLine('ステージC用ライン')]: makeProgress()[keyForLine('ステージC用ライン')]! }),
    )
    await enterStageSelect(container)

    await act(async () => clickFilter(container, '失敗あり'))

    expect(container.querySelector('.midgame-stage-grid')).toBeNull()
    const empty = container.querySelector('.midgame-stage-select__empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('条件に一致するステージがありません')
  })

  it('フィルタ選択はlocalStorageへ永続化され、再マウント後も保持される', async () => {
    await enterStageSelect(container)
    await act(async () => clickFilter(container, '未クリア(★0)'))

    expect(localStorage.getItem(MIDGAME_REVIEW_FILTER_STORAGE_KEY)).toBe(JSON.stringify('uncleared'))
    expect(gridNumbers(container)).toEqual(['1', '2'])

    // 「再マウント」でアプリ再起動をシミュレートする。
    render(null, container)
    await enterStageSelect(container)

    expect(gridNumbers(container)).toEqual(['1', '2'])
    const activeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.midgame-stage-select__filter-button'),
    ).find((btn) => btn.textContent === '未クリア(★0)')
    expect(activeButton?.classList.contains('midgame-stage-select__filter-button--active')).toBe(true)
  })

  it('グリッドセルは★0〜3(bestStars)を表示する(旧: モード数の代わり)', async () => {
    await enterStageSelect(container)

    const cells = Array.from(container.querySelectorAll<HTMLButtonElement>('.midgame-stage-grid__cell'))
    const cellForStage = (num: string) =>
      cells.find((c) => c.querySelector('.midgame-stage-grid__number')?.textContent === num)

    expect(cellForStage('1')?.querySelector('.midgame-stage-grid__stars')?.textContent).toBe('☆☆☆') // A: 未挑戦
    expect(cellForStage('2')?.querySelector('.midgame-stage-grid__stars')?.textContent).toBe('☆☆☆') // B: ★0
    expect(cellForStage('3')?.querySelector('.midgame-stage-grid__stars')?.textContent).toBe('★★☆') // C: ★2
    expect(cellForStage('4')?.querySelector('.midgame-stage-grid__stars')?.textContent).toBe('★☆☆') // D: ★1(bestStars、failCountは加味しない)
  })
})
