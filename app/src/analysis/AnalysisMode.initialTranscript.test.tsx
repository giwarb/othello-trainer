// @vitest-environment jsdom
/**
 * T133 追加要件1(T132コードレビュー中(a)指摘、
 * tasks/review/T130-T132-learning-features-claude-review.md「中(a)」参照):
 *
 * 「この対局を棋譜解析で振り返る」導線(T132、`initialTranscript`props)の
 * 自動解析は、修正前は`AnalysisMode`のマウント直後のeffectで即座に
 * `startAnalysis`を呼んでいたため、定石DB(`josekiDb`)の読み込み
 * (別のマウント時effect、非同期fetch)が完了する前に解析が開始され、常に
 * `josekiDb: null`で解析されていた。これは手動貼り付け経路(通常はDBロード済みの
 * 状態でユーザーがボタンを押す)と異なり、定石内の手の悪手誤判定除外・
 * `evalSource: 'joseki'`表示(T038)が振り返り解析では常に効かないという
 * 経路間の挙動差を生んでいた。
 *
 * 修正: `josekiDbReady`(`app.tsx`のCPU着手effectと同じ命名パターン)を導入し、
 * 定石DBの読み込み完了(成功・失敗いずれか)を待ってから自動解析を開始する。
 *
 * 本テストは、定石DBの読み込みを手動で制御可能な`Promise`に差し替え、
 * (1)ロード未完了の間は自動解析が開始されないこと(`onInitialTranscriptConsumed`
 * 未呼び出し・`lookupJosekiNode`未呼び出し)、(2)ロード完了後に自動解析が開始され、
 * `analyzeGame`(内部で`lookupJosekiNode`を呼ぶ)に`null`でない`josekiDb`が
 * 実際に渡ること、を検証する。`lookupJosekiNode`が一度でも呼ばれていれば
 * `analyzeGame`内の`josekiDb ? lookupJosekiNode(...) : null`分岐(analyzeGame.ts参照)
 * が真になった証拠であり、`josekiDb`が`null`でなかったことを直接示す
 * (修正前のコードに対して実行すると、解析自体はマウント直後に`josekiDb: null`で
 * 完了してしまい`lookupJosekiNode`が一度も呼ばれないため、このアサーションで
 * 失敗することを確認済み)。
 *
 * 定石DBのfetch(`loadJosekiDb`)・エンジンWorker(`getSharedEngineClient`)・
 * 盤面のcanvas描画(`Board`)は、このリポジトリのvitest環境では動かせないため
 * モックに差し替える。棋譜解析側のIndexedDBキャッシュ(`analysis/cache.ts`)は
 * `fake-indexeddb/auto`で実物を動かす(`app.playmode.review.test.tsx`と同じ方針)。
 */
import 'fake-indexeddb/auto'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeResponseMessage, MoveEvalJson } from '../engine/types.ts'
import type { JosekiDb } from '../joseki/types.ts'

let resolveJosekiDb: ((db: JosekiDb) => void) | null = null
const lookupJosekiNodeCalls: unknown[] = []

vi.mock('../joseki/lookup.ts', () => ({
  // テストから任意のタイミングで解決できるよう、Promiseの`resolve`を
  // 外側の`resolveJosekiDb`へ退避しておく(ロード未完了状態を任意時間維持できる)。
  loadJosekiDb: () =>
    new Promise<JosekiDb>((resolve) => {
      resolveJosekiDb = resolve
    }),
  lookupJosekiNode: (...args: unknown[]) => {
    lookupJosekiNodeCalls.push(args)
    return null
  },
}))

vi.mock('../engine/sharedClient.ts', () => {
  const analyzeResponse: AnalyzeResponseMessage = {
    id: 0,
    final: true,
    depth: 1,
    pv: ['a1'],
    score: { type: 'midgame', discDiff: 0 },
    nodes: 0,
    nps: 0,
  }
  const allMoves: MoveEvalJson[] = [{ move: 'd3', score: 0, discDiff: 0, type: 'midgame' }]
  return {
    getSharedEngineClient: () => ({
      requestAnalyze: () => Promise.resolve(analyzeResponse),
      requestAnalyzeAll: () => Promise.resolve(allMoves),
      terminate: () => {},
    }),
  }
})

vi.mock('../components/Board.tsx', () => ({
  Board: () => <div data-testid="stub-board" />,
  FLIP_ANIMATION_MS: 0,
}))

/** Promiseチェーン越しのstate更新を数ラウンド分待つ(他のapp.*.test.tsxと同じ方針)。 */
async function flushAsyncEffects(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('T133: 振り返り自動解析と定石DBロードの整合(T132コードレビュー中(a)指摘の回帰テスト)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    resolveJosekiDb = null
    lookupJosekiNodeCalls.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    vi.restoreAllMocks()
  })

  it('定石DBロード完了前は自動解析を開始せず、完了後に josekiDb 込みで解析する', async () => {
    const { AnalysisMode } = await import('./AnalysisMode.tsx')
    const onInitialTranscriptConsumed = vi.fn()

    await act(async () => {
      render(
        <AnalysisMode initialTranscript="d3" onInitialTranscriptConsumed={onInitialTranscriptConsumed} />,
        container,
      )
    })
    // マウント直後(定石DBロードのPromiseはまだ`resolveJosekiDb`を待っている状態)。
    await flushAsyncEffects(3)

    // 定石DBロード未完了のうちは自動解析が始まっていないはず
    // (修正前は`josekiDb: null`のまま即座に解析が開始され、この時点で
    // `onInitialTranscriptConsumed`が呼ばれていた)。
    expect(onInitialTranscriptConsumed).not.toHaveBeenCalled()
    expect(lookupJosekiNodeCalls.length).toBe(0)
    expect(resolveJosekiDb).not.toBeNull()

    // 定石DBのロードを完了させる(空のDAGで十分。中身は`lookupJosekiNode`の
    // モックが使うので実際のデータ構造には依存しない)。
    await act(async () => {
      resolveJosekiDb?.({} as JosekiDb)
    })
    await flushAsyncEffects()

    // ロード完了後に自動解析が開始・完了している。
    expect(onInitialTranscriptConsumed).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('解析完了: 1手')

    // `lookupJosekiNode`が呼ばれていること自体が、`analyzeGame`に渡された
    // `josekiDb`が`null`でなかった証拠(analyzeGame.tsの
    // `josekiDb ? lookupJosekiNode(...) : null`分岐、josekiDbがnullなら
    // 呼ばれない)。
    expect(lookupJosekiNodeCalls.length).toBeGreaterThan(0)
  })
})
