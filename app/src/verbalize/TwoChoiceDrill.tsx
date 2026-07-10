import { useEffect, useState } from 'preact/hooks'
import { buildAttribution } from '../analysis/attribution.ts'
import { detectMotifs, type MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionBreakdown } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit } from '../engine/types.ts'
import { applyMove, notationToSquare, opposite } from '../game/othello.ts'
import { getAllPoolEntries } from '../midgame/pool.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import { getAllAttempts, getAttemptsForPosition, saveAttempt } from './attemptsStore.ts'
import { computeConceptStats, conceptWeight, type ConceptStat } from './conceptStats.ts'
import { GlossaryPopover } from './GlossaryPopover.tsx'
import {
  attributionConcentration,
  computeTargetTags,
  judgeVerbalization,
  type JudgeVerbalizationResult,
  TWO_CHOICE_CONCENTRATION_THRESHOLD,
} from './judgeVerbalization.ts'
import { filterPoolBySource, pickProblem, weightedRandomIndex } from './pickProblem.ts'
import { findReasonTag, MAX_CHOSEN_TAGS } from './reasonTags.ts'
import { TagPicker } from './TagPicker.tsx'
import type { ProblemSource, VerbalizeAttemptRecord, VerbalizeCaseKind, VerbalizeProblem } from './types.ts'
import './PracticeMode.css'
import './TwoChoiceDrill.css'

/** 候補手の探索条件。`PracticeMode.tsx`の`VERBALIZE_ANALYZE_LIMIT`と同じ値(T034の教訓によりtimeMsを必ず設定)。 */
const DRILL_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 300, exactFromEmpties: 24 }

/**
 * 「差が1概念に集約された局面ペア」(設計書§6.2)を探すためにプールから試す
 * 最大試行回数。事前生成パイプラインは持たず、その場で数回サンプリングして
 * 閾値(`TWO_CHOICE_CONCENTRATION_THRESHOLD`)を満たすものを探す簡易ロジックで
 * 代替する(タスク仕様「本タスクでのスコープ縮小」で明示的に許容されている方式)。
 */
const MAX_SELECTION_ATTEMPTS = 6

/**
 * T036要件3「概念レッスン」用: 特定タグ(`requiredTagId`)に絞り込んで候補を探す際の
 * 最大試行回数。狙ったタグに一致する局面はランダムサンプリングでは見つかりにくいため
 * 通常の`MAX_SELECTION_ATTEMPTS`より広めに取るが、無限ループ・ハングを避けるため
 * 上限は必ず設ける(CLAUDE.mdの完全読み・深い探索のtime_ms予算ルールと同じ精神で、
 * 「回数」を上限とする形で対応する)。
 */
const MAX_CONCEPT_SELECTION_ATTEMPTS = 15

/**
 * T036要件6「出題バイアスへの反映」: 閾値を満たす候補を何件集めてから
 * 弱点タグ優先の重み付き抽選(`weightedRandomIndex`)で1件選ぶか。既存の
 * `MAX_SELECTION_ATTEMPTS`(6)を超えない範囲に収め、既存のエンジン呼び出し
 * コストを増やしすぎないようにする。
 */
const MAX_QUALIFIED_CANDIDATES = 3

const SOURCE_OPTIONS: readonly { value: ProblemSource; label: string }[] = [
  { value: 'pool', label: '中盤練習プール(全件)' },
  { value: 'myBlunder', label: '自分の悪手局面' },
]

const CASE_TITLE: Record<VerbalizeCaseKind, string> = {
  correctBoth: '完全正解',
  correctMoveWrongReason: '正解だが理由が違う',
  wrongMoveCorrectReason: '着眼は正しい',
  wrongBoth: '要復習',
}

const CASE_MESSAGE: Record<VerbalizeCaseKind, string> = {
  correctBoth: '手も理由も正しく捉えられています。',
  correctMoveWrongReason: '手は正解でしたが、選んだ理由は2手の差の実際の根拠とズレていました。',
  wrongMoveCorrectReason: '着眼点(理由)は正しいです。その観点で、もう一度2択を選び直してみましょう。',
  wrongBoth: '手も理由も違いました。関連しそうな概念の簡単な説明を確認してみましょう。',
}

/**
 * T035「二択比較ドリル」1問ぶんのデータ。T036の`ConceptLesson.tsx`が特定タグに
 * 絞り込んで再利用するため、本インターフェースと`buildDrillProblem`をexportする。
 */
export interface DrillProblem {
  readonly problem: VerbalizeProblem
  /** 探索(深い読み)で評価が高かった方の手(=正解)。 */
  readonly bestMove: string
  /** 表示順(ランダムにシャッフル済み)の2候補。 */
  readonly options: readonly [string, string]
  /** 2候補それぞれを打った局面間の評価内訳分解(`bestMove`側 − もう一方側、手番視点)。 */
  readonly attribution: AttributionBreakdown
  /** `bestMove`について検出されたモチーフ。 */
  readonly motifs: readonly MotifDefinition[]
  readonly concentration: number
  /** `judgeVerbalization.ts`の`computeTargetTags`(要件6・T036概念レッスンのタグ絞り込みに使う)。 */
  readonly targetTags: readonly string[]
}

type Phase = 'settings' | 'loading' | 'choosing' | 'tags' | 'result'

interface ResultData {
  readonly judgement: JudgeVerbalizationResult
  readonly playedMove: string
  readonly bestMove: string
  readonly pastAttempts: readonly VerbalizeAttemptRecord[]
}

/** `buildDrillProblem`が要求する最小限のエンジンインターフェース。`ConceptLesson.tsx`も再利用する。 */
export interface DrillEngine {
  requestAnalyzeAll: EngineClient['requestAnalyzeAll']
  requestEvalTerms: EngineClient['requestEvalTerms']
  requestFeatureSet: EngineClient['requestFeatureSet']
}

/** `buildDrillProblem`の挙動を制御する追加オプション(T036で追加)。 */
export interface BuildDrillProblemOptions {
  /**
   * T036要件6: タグ別弱点統計(`conceptStats.ts`)。指定した場合、閾値を満たす候補が
   * 複数見つかったとき、弱点タグ(正答率・理由正答率が低いタグ)に関連する候補ほど
   * 選ばれやすくなるよう重み付き抽選する。省略時(既定の空Map)は従来どおり均等抽選。
   */
  readonly conceptStats?: ReadonlyMap<string, ConceptStat>
  /**
   * T036要件3(概念レッスン用): 指定した場合、`computeTargetTags`の結果にこのタグIDを
   * 含む候補が見つかるまで探し、見つかった時点で即座に返す(弱点重み付けは適用しない、
   * 濃度閾値も問わない)。見つからなければ`null`を返す(呼び出し側で
   * 「見つかりませんでした」を表示する)。
   */
  readonly requiredTagId?: string
}

/**
 * 1問ぶんの二択比較ドリル局面を組み立てる(要件7、設計書§6.2)。T036で
 * `ConceptLesson.tsx`(特定タグへの絞り込み)・弱点タグ優先の重み付け(要件6)に
 * 対応させるため、`options`を追加してexportした(ロジックの二重管理を避けるため、
 * `ConceptLesson.tsx`は本関数をそのまま再利用する)。
 *
 * `entries`(`source`でフィルタ前のプール全件)からランダムに局面を選び、探索
 * (`requestAnalyzeAll`)で評価上位2手を候補とする。2候補それぞれを打った局面の
 * 評価内訳分解(`buildAttribution`)を求め、寄与の集中度(`attributionConcentration`)が
 * 閾値以上になる局面を探す。`options.requiredTagId`未指定時は、閾値を満たす候補を
 * 最大`MAX_QUALIFIED_CANDIDATES`件集めた上で弱点重み付き抽選(`options.conceptStats`)
 * により1件選ぶ(見つからなければ最後に試した局面をフォールバックとして返す、
 * 事前生成パイプライン無しの簡易版)。
 */
export async function buildDrillProblem(
  engine: DrillEngine,
  entries: readonly MidgamePoolEntry[],
  source: ProblemSource,
  random: () => number = Math.random,
  options: BuildDrillProblemOptions = {},
): Promise<DrillProblem | null> {
  const maxAttempts = options.requiredTagId ? MAX_CONCEPT_SELECTION_ATTEMPTS : MAX_SELECTION_ATTEMPTS
  let fallback: DrillProblem | null = null
  const qualified: DrillProblem[] = []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const problem = pickProblem(entries, source, random)
    if (!problem) break

    const allMoves = await engine.requestAnalyzeAll(problem.board, problem.sideToMove, DRILL_ANALYZE_LIMIT)
    if (allMoves.length < 2) continue

    const sorted = [...allMoves].sort((a, b) => b.discDiff - a.discDiff)
    const best = sorted[0]!
    const other = sorted[1]!
    const opponentSide = opposite(problem.sideToMove)
    const bestSquare = notationToSquare(best.move)
    const boardAfterBest = applyMove(problem.board, problem.sideToMove, bestSquare)
    const boardAfterOther = applyMove(problem.board, problem.sideToMove, notationToSquare(other.move))

    const [bestTerms, otherTerms, featureResp] = await Promise.all([
      engine.requestEvalTerms(boardAfterBest, opponentSide),
      engine.requestEvalTerms(boardAfterOther, opponentSide),
      engine.requestFeatureSet(problem.board, problem.sideToMove, best.move),
    ])

    const attribution = buildAttribution(bestTerms, otherTerms, problem.sideToMove)
    const motifs = detectMotifs({
      beforeBoard: problem.board,
      side: problem.sideToMove,
      square: bestSquare,
      features: featureResp.features,
    })
    const concentration = attributionConcentration(attribution)
    const targetTags = computeTargetTags(attribution, motifs)
    const options2: [string, string] = random() < 0.5 ? [best.move, other.move] : [other.move, best.move]

    const drill: DrillProblem = {
      problem,
      bestMove: best.move,
      options: options2,
      attribution,
      motifs,
      concentration,
      targetTags,
    }

    if (options.requiredTagId) {
      if (targetTags.includes(options.requiredTagId)) return drill
      continue
    }

    fallback = drill
    if (concentration >= TWO_CHOICE_CONCENTRATION_THRESHOLD) {
      qualified.push(drill)
      if (qualified.length >= MAX_QUALIFIED_CANDIDATES) break
    }
  }

  if (options.requiredTagId) return null

  if (qualified.length > 0) {
    const weights = qualified.map((d) => conceptWeight(d.targetTags, options.conceptStats ?? new Map()))
    return qualified[weightedRandomIndex(weights, random)]!
  }
  return fallback
}

/**
 * 二択比較ドリル(T035、設計書§6.2)。「AとB、どちらが良い? 理由は?」形式で、
 * 差が1概念に集約されやすい局面ペアを出題する簡易版(タスク仕様「本タスクでの
 * スコープ縮小」参照。事前生成パイプラインではなく、その場でのサンプリング+
 * フィルタで代替している)。採点は`PracticeMode.tsx`と同じ`judgeVerbalization`を
 * 再利用する。
 */
export function TwoChoiceDrill() {
  const [source, setSource] = useState<ProblemSource>('pool')
  const [pool, setPool] = useState<MidgamePoolEntry[] | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('settings')
  const [drillProblem, setDrillProblem] = useState<DrillProblem | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [chosenMove, setChosenMove] = useState<string | null>(null)
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')

  const [judging, setJudging] = useState(false)
  const [judgeError, setJudgeError] = useState<string | null>(null)
  const [resultData, setResultData] = useState<ResultData | null>(null)

  /** T036要件2: 理由タグ選択UI(`TagPicker`)から用語集への1タップ導線用。 */
  const [glossaryPopoverTagId, setGlossaryPopoverTagId] = useState<string | null>(null)

  // エンジンWorkerはアプリ全体で1つのインスタンスを共有する(T054)。
  function getEngine(): EngineClient {
    return getSharedEngineClient()
  }

  useEffect(() => {
    let cancelled = false
    getAllPoolEntries()
      .then((entries) => {
        if (!cancelled) setPool(entries)
      })
      .catch((error: unknown) => {
        console.error('出題プールの読み込みに失敗しました', error)
        if (!cancelled) setPoolError('出題プールの読み込みに失敗しました。ページを再読み込みしてください。')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filteredCount = pool ? filterPoolBySource(pool, source).length : 0

  async function startDrill(): Promise<void> {
    if (!pool) return
    setPhase('loading')
    setBuildError(null)
    try {
      // T036要件6: 弱点タグ(正答率・理由正答率が低いタグ)を優先する重み付けのため、
      // 過去の挑戦記録から`conceptStats`を求めて渡す(1回の出題ごとに1回だけIndexedDBを読む)。
      const conceptStats = computeConceptStats(await getAllAttempts())
      const drill = await buildDrillProblem(getEngine(), pool, source, Math.random, { conceptStats })
      if (!drill) {
        setBuildError('2択に足る候補手を持つ局面が見つかりませんでした。もう一度お試しください。')
        setPhase('settings')
        return
      }
      setDrillProblem(drill)
      setChosenMove(null)
      setChosenTags([])
      setFreeText('')
      setResultData(null)
      setJudgeError(null)
      setPhase('choosing')
    } catch (error) {
      console.error('二択比較ドリルの局面生成に失敗しました', error)
      setBuildError('局面生成に失敗しました。もう一度お試しください。')
      setPhase('settings')
    }
  }

  function chooseMove(move: string): void {
    setChosenMove(move)
    setPhase('tags')
  }

  function toggleTag(id: string): void {
    setChosenTags((prev) => {
      if (prev.includes(id)) return prev.filter((t) => t !== id)
      if (prev.length >= MAX_CHOSEN_TAGS) return prev
      return [...prev, id]
    })
  }

  async function finalizeAndJudge(move: string, tags: readonly string[], text: string): Promise<void> {
    if (!drillProblem) return
    setJudging(true)
    setJudgeError(null)
    try {
      const moveCorrect = move === drillProblem.bestMove
      const pastAttempts = await getAttemptsForPosition(drillProblem.problem.positionKey)
      const judgement = judgeVerbalization({
        moveCorrect,
        chosenTags: tags,
        attribution: drillProblem.attribution,
        motifs: drillProblem.motifs,
      })

      const record: VerbalizeAttemptRecord = {
        id: `verbalize-drill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        positionKey: drillProblem.problem.positionKey,
        sideToMove: drillProblem.problem.sideToMove,
        chosenMove: move,
        chosenTags: [...tags],
        freeText: text,
        caseKind: judgement.caseKind,
        createdAt: new Date().toISOString(),
      }
      await saveAttempt(record)

      setResultData({ judgement, playedMove: move, bestMove: drillProblem.bestMove, pastAttempts })
      setPhase('result')
    } catch (error) {
      console.error('判定に失敗しました', error)
      setJudgeError('判定に失敗しました。もう一度お試しください。')
    } finally {
      setJudging(false)
    }
  }

  function handleTagsSubmit(): void {
    if (!chosenMove) return
    if (chosenTags.length < 1 || chosenTags.length > MAX_CHOSEN_TAGS) return
    void finalizeAndJudge(chosenMove, chosenTags, freeText)
  }

  /** 「手×理由○」: 着眼(タグ・自由記述)は維持したまま、同じ2択を選び直す(要件5)。 */
  function retrySameDrill(): void {
    setChosenMove(null)
    setResultData(null)
    setJudgeError(null)
    setPhase('choosing')
  }

  function nextDrill(): void {
    void startDrill()
  }

  function backToSettings(): void {
    setPhase('settings')
    setDrillProblem(null)
    setChosenMove(null)
    setChosenTags([])
    setFreeText('')
    setResultData(null)
    setJudgeError(null)
  }

  return (
    <div class="verbalize-practice-mode two-choice-drill">
      {poolError && <p class="notice notice--error">{poolError}</p>}

      {phase === 'settings' && (
        <section class="verbalize-settings">
          <p>二択比較ドリル: 「どちらが良い? 理由は?」形式で出題します</p>

          <fieldset class="verbalize-settings__group">
            <legend>出典</legend>
            {SOURCE_OPTIONS.map(({ value, label }) => (
              <label class="verbalize-settings__option" key={value}>
                <input
                  type="radio"
                  name="two-choice-source"
                  value={value}
                  checked={source === value}
                  onChange={() => setSource(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          {buildError && <p class="notice notice--error">{buildError}</p>}
          {pool === null && !poolError && <p class="notice">出題プールを読み込み中...</p>}
          {pool !== null && filteredCount === 0 && (
            <p class="notice">出題プールが空です。中盤練習・棋譜解析モードで局面を蓄積してください。</p>
          )}

          <button type="button" disabled={pool === null || filteredCount === 0} onClick={() => void startDrill()}>
            開始
          </button>
        </section>
      )}

      {phase === 'loading' && (
        <section class="verbalize-problem">
          <p class="notice">条件に合う局面を探しています...</p>
        </section>
      )}

      {(phase === 'choosing' || phase === 'tags') && drillProblem && (
        <section class="verbalize-problem">
          <p class="status">評価値は表示されません。どちらの手が良いか選んでください。</p>

          <div class="board-container">
            <Board board={drillProblem.problem.board} sideToMove={drillProblem.problem.sideToMove} />
          </div>

          <div class="two-choice-drill__options">
            {drillProblem.options.map((move) => (
              <button
                type="button"
                key={move}
                class={`two-choice-drill__option-button${chosenMove === move ? ' two-choice-drill__option-button--chosen' : ''}`}
                disabled={phase === 'tags'}
                onClick={() => chooseMove(move)}
              >
                {move}
              </button>
            ))}
          </div>

          {judging && <p class="notice">判定中...</p>}
          {judgeError && <p class="notice notice--error">{judgeError}</p>}

          {phase === 'tags' && chosenMove !== null && (
            <div class="verbalize-tags">
              <p>
                選んだ手: {chosenMove}(
                <button type="button" class="verbalize-tags__reselect" onClick={() => setPhase('choosing')}>
                  選び直す
                </button>
                )
              </p>
              <p>
                理由タグを1〜3個選んでください({chosenTags.length}/{MAX_CHOSEN_TAGS})
              </p>

              <TagPicker chosenTags={chosenTags} onToggle={toggleTag} onInfo={setGlossaryPopoverTagId} />

              <label class="verbalize-tags__freetext">
                自由記述メモ(任意)
                <textarea
                  value={freeText}
                  onInput={(event) => setFreeText((event.target as HTMLTextAreaElement).value)}
                  rows={3}
                  placeholder="2手の違いをどう考えたか、自分の言葉でメモしておきましょう"
                />
              </label>

              <div class="verbalize-tags__buttons">
                <button
                  type="button"
                  disabled={chosenTags.length < 1 || chosenTags.length > MAX_CHOSEN_TAGS || judging}
                  onClick={handleTagsSubmit}
                >
                  {judging ? '採点中...' : '採点する'}
                </button>
              </div>
            </div>
          )}

          <button type="button" class="verbalize-problem__quit" onClick={backToSettings}>
            やめる
          </button>
        </section>
      )}

      {phase === 'result' && resultData && (
        <section class={`verbalize-result verbalize-result--${resultData.judgement.caseKind}`}>
          <h2>{CASE_TITLE[resultData.judgement.caseKind]}</h2>
          <p>{CASE_MESSAGE[resultData.judgement.caseKind]}</p>

          <p>
            あなたの手: {resultData.playedMove}
            {resultData.judgement.moveCorrect ? '(正解)' : `(不正解、正解手: ${resultData.bestMove})`}
          </p>

          <div class="verbalize-result__tags">
            <p>あなたが選んだ理由タグ: {chosenTags.map((id) => findReasonTag(id)?.label ?? id).join('、') || '(なし)'}</p>
            <p>
              正しい理由タグ(2手の差の根拠):{' '}
              {resultData.judgement.targetTags.map((id) => findReasonTag(id)?.label ?? id).join('、') ||
                '(明確な単一の根拠は検出されませんでした)'}
            </p>
          </div>

          {resultData.judgement.caseKind === 'wrongBoth' && (
            <div class="verbalize-result__lesson">
              <p>関連する概念の簡単な説明(T036用語集の実装まではこの簡易説明で代替します):</p>
              <ul>
                {resultData.judgement.targetTags.map((id) => {
                  const tag = findReasonTag(id)
                  return tag ? (
                    <li key={id}>
                      <strong>{tag.label}</strong>: {tag.description}
                    </li>
                  ) : null
                })}
              </ul>
            </div>
          )}

          {resultData.pastAttempts.length > 0 && (
            <div class="verbalize-result__history">
              <p>この局面への過去の自分の記述:</p>
              <ul>
                {resultData.pastAttempts.map((record) => (
                  <li key={record.id}>
                    <span class="verbalize-result__history-date">{record.createdAt.slice(0, 10)}</span>
                    {' '}手: {record.chosenMove} / {record.freeText || '(自由記述なし)'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div class="verbalize-result__buttons">
            {resultData.judgement.caseKind === 'wrongMoveCorrectReason' && (
              <button type="button" onClick={retrySameDrill}>
                同じ2択でもう一度選ぶ
              </button>
            )}
            <button type="button" onClick={nextDrill}>
              次の問題へ
            </button>
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}

      {glossaryPopoverTagId && (
        <GlossaryPopover
          tagId={glossaryPopoverTagId}
          engine={getEngine()}
          onClose={() => setGlossaryPopoverTagId(null)}
        />
      )}
    </div>
  )
}
