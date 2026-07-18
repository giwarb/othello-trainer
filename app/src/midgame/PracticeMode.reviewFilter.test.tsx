// @vitest-environment jsdom
/**
 * T130: 中盤練習ステージ一覧の復習フィルタ(すべて/未挑戦/失敗あり/未クリア/
 * クリア済み)が`localStorage`の挑戦記録(`stageProgress.ts`、T119の判定モード
 * 別2階層構造)どおりに絞り込まれること、選択が`localStorage`へ永続化される
 * こと、および**判定モードの切り替えにフィルタ結果が追従する**(要件2)ことを
 * 検証する。
 *
 * 4件の合成定石ラインからステージプールを構築し、各ステージのキーへ既知の
 * 進捗を事前投入する。注意: 定石DB正規化(`joseki/normalize.ts`の
 * `opForFirstMove`)は初手のマス自体を基準に全着手を正規化するため、
 * 「初手だけが異なる深さ1のライン」は初手が何であっても同じ正規化後の
 * 1局面に収束してしまい、4件に分離できない(黒の初手4種
 * d3/c4/f5/e6はいずれも盤面の対称変換で移りあう関係にあるため)。
 * そのため本テストの4ラインは**全て同じ初手(f5)**を共有し、2手目以降
 * (f5の合法応手f4/d6/f6、および3手目まで進めたf5→f4→c3)で互いに区別する。
 * 4手とも実際に合法な手順であることは事前にscratchpadで
 * `game/othello.ts`を直接実行して確認済み。
 * モック方針は`PracticeMode.staleSession.test.tsx`と同じ(Board/engineを
 * スタブ化、`loadJosekiDb`を合成DBに差し替え。対局は行わず設定画面・
 * ステージ一覧画面のみを操作する)。
 */
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJosekiDb } from '../joseki/buildDb.ts'
import type { RawJosekiLine } from '../joseki/types.ts'
import { MIDGAME_REVIEW_FILTER_STORAGE_KEY } from '../settings/reviewFilter.ts'
import { buildMidgameStagePool } from './stagePool.ts'
import { MIDGAME_STAGE_PROGRESS_STORAGE_KEY, type StageProgress } from './stageProgress.ts'

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

const NOW = '2026-07-18T00:00:00.000Z'

/**
 * ステージA〜D(定義順でstageNumber1〜4)に、判定モード別のフィルタ挙動を
 * 検証するための挑戦記録:
 * - A: 記録なし -> どの判定モードでも未挑戦。
 * - B: 「厳格」でのみ失敗1回(クリアなし) -> 厳格では挑戦済み未クリア・失敗あり、
 *   標準では未挑戦(記録が無いため)。
 * - C: 「厳格」でのみクリア1回(失敗なし) -> 厳格ではクリア済み、標準では未挑戦。
 * - D: 「厳格」で失敗2回(クリアなし)・「標準」でクリア1回(失敗なし)
 *   -> 厳格では挑戦済み未クリア・失敗あり、標準ではクリア済み・失敗なし。
 *   要件2「現在選択中の判定モードの記録で判定する」を、判定モード切り替えで
 *   結果が変わることとして検証する要。
 */
function makeProgress(): StageProgress {
  const keyB = keyForLine('ステージB用ライン')
  const keyC = keyForLine('ステージC用ライン')
  const keyD = keyForLine('ステージD用ライン')
  return {
    [keyB]: {
      strict: { firstClearedAt: null, lastClearedAt: null, clearCount: 0, failCount: 1, lastAttemptAt: NOW, lastResult: 'fail' },
    },
    [keyC]: {
      strict: { firstClearedAt: NOW, lastClearedAt: NOW, clearCount: 1, failCount: 0, lastAttemptAt: NOW, lastResult: 'clear' },
    },
    [keyD]: {
      strict: { firstClearedAt: null, lastClearedAt: null, clearCount: 0, failCount: 2, lastAttemptAt: NOW, lastResult: 'fail' },
      standard: { firstClearedAt: NOW, lastClearedAt: NOW, clearCount: 1, failCount: 0, lastAttemptAt: NOW, lastResult: 'clear' },
    },
  }
}

async function flushAsyncEffects(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** 設定画面 → ステージ一覧まで進める共通手順。 */
async function enterStageSelect(container: HTMLDivElement): Promise<void> {
  const { PracticeMode } = await import('./PracticeMode.tsx')
  await act(async () => {
    render(<PracticeMode />, container)
  })
  await flushAsyncEffects()

  const stageListButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
    btn.textContent?.includes('ステージ一覧'),
  )
  expect(stageListButton).toBeDefined()
  await act(async () => {
    stageListButton?.click()
  })
  await flushAsyncEffects()

  expect(container.querySelector('.midgame-stage-select')).not.toBeNull()
}

/** ステージ一覧 → 「設定に戻る」で設定画面へ戻る。 */
async function backToSettings(container: HTMLDivElement): Promise<void> {
  const backButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
    btn.textContent === '設定に戻る',
  )
  expect(backButton).toBeDefined()
  await act(async () => {
    backButton?.click()
  })
  await flushAsyncEffects()
}

/** 設定画面で判定モードのラジオボタンを切り替える。 */
async function selectJudgeMode(container: HTMLDivElement, value: 'strict' | 'standard' | 'noReversal'): Promise<void> {
  const radio = container.querySelector<HTMLInputElement>(`input[name="midgame-judge-mode"][value="${value}"]`)
  expect(radio).not.toBeNull()
  await act(async () => {
    radio?.click()
  })
  await flushAsyncEffects()
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

describe('T130: 中盤練習ステージ一覧の復習フィルタ', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(MIDGAME_STAGE_PROGRESS_STORAGE_KEY, JSON.stringify(makeProgress()))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('判定モード「厳格」(既定)で、フィルタ5種それぞれの表示ステージ番号が記録どおりになる', async () => {
    await enterStageSelect(container)

    // 既定は「すべて」: 4ステージすべて表示。
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])

    await act(async () => clickFilter(container, '未挑戦'))
    expect(gridNumbers(container)).toEqual(['1'])

    await act(async () => clickFilter(container, '失敗あり'))
    expect(gridNumbers(container)).toEqual(['2', '4'])

    await act(async () => clickFilter(container, '未クリア'))
    expect(gridNumbers(container)).toEqual(['1', '2', '4'])

    await act(async () => clickFilter(container, 'クリア済み'))
    expect(gridNumbers(container)).toEqual(['3'])

    await act(async () => clickFilter(container, 'すべて'))
    expect(gridNumbers(container)).toEqual(['1', '2', '3', '4'])
  })

  it('該当0件のとき、グリッドの代わりに空表示メッセージを出す', async () => {
    // 判定モードを「標準」へ切り替えると、標準モードでの記録を持つのはD
    // (クリア)のみ(A・B・Cは標準モードでは未挑戦扱い)なので、「失敗あり」
    // フィルタは0件になる。
    await enterStageSelect(container)
    await backToSettings(container)
    await selectJudgeMode(container, 'standard')
    const stageListButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('ステージ一覧'),
    )
    await act(async () => stageListButton?.click())
    await flushAsyncEffects()

    await act(async () => clickFilter(container, '失敗あり'))

    expect(container.querySelector('.midgame-stage-grid')).toBeNull()
    const empty = container.querySelector('.midgame-stage-select__empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('条件に一致するステージがありません')
  })

  it('要件2: 判定モードの切り替えにフィルタ結果が追従する(現在選択中の判定モードの記録で判定)', async () => {
    await enterStageSelect(container)

    // 厳格モード: 「クリア済み」はCのみ、「失敗あり」はB・D。
    await act(async () => clickFilter(container, 'クリア済み'))
    expect(gridNumbers(container)).toEqual(['3'])

    // 判定モードを「標準」へ切り替える(フィルタ選択「クリア済み」はそのまま保持)。
    await backToSettings(container)
    await selectJudgeMode(container, 'standard')
    const stageListButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.textContent?.includes('ステージ一覧'),
    )
    await act(async () => stageListButton?.click())
    await flushAsyncEffects()

    // フィルタ選択(「クリア済み」)は追従して保持されている。
    const activeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.midgame-stage-select__filter-button'),
    ).find((btn) => btn.textContent === 'クリア済み')
    expect(activeButton?.classList.contains('midgame-stage-select__filter-button--active')).toBe(true)

    // 標準モードでは、C(厳格クリアのみ)は対象外になり、D(標準クリア)が対象になる。
    expect(gridNumbers(container)).toEqual(['4'])

    // 「失敗あり」も標準モードの記録に追従して切り替わる(B・Dの失敗は厳格モードの記録であり、
    // 標準モードにはB・Dの記録自体が存在しないため0件になる)。
    await act(async () => clickFilter(container, '失敗あり'))
    expect(container.querySelector('.midgame-stage-grid')).toBeNull()
  })

  it('フィルタ選択はlocalStorageへ永続化され、再マウント後も保持される', async () => {
    await enterStageSelect(container)
    await act(async () => clickFilter(container, '未クリア'))

    expect(localStorage.getItem(MIDGAME_REVIEW_FILTER_STORAGE_KEY)).toBe(JSON.stringify('uncleared'))
    expect(gridNumbers(container)).toEqual(['1', '2', '4'])

    // 「再マウント」でアプリ再起動をシミュレートする。
    render(null, container)
    await enterStageSelect(container)

    expect(gridNumbers(container)).toEqual(['1', '2', '4'])
    const activeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.midgame-stage-select__filter-button'),
    ).find((btn) => btn.textContent === '未クリア')
    expect(activeButton?.classList.contains('midgame-stage-select__filter-button--active')).toBe(true)
  })
})
