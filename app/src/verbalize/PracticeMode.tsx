import { useEffect, useState } from 'preact/hooks'
import { AttributionWaterfall } from '../analysis/AttributionWaterfall.tsx'
import { buildAttribution } from '../analysis/attribution.ts'
import { detectMotifs, type MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionBreakdown } from '../analysis/types.ts'
import { Board } from '../components/Board.tsx'
import type { EngineClient } from '../engine/client.ts'
import { getSharedEngineClient } from '../engine/sharedClient.ts'
import type { AnalyzeLimit } from '../engine/types.ts'
import { applyMove, notationToSquare, opposite, squareToNotation } from '../game/othello.ts'
import { judgeMidgameMove } from '../midgame/judgeMidgameMove.ts'
import { getAllPoolEntries } from '../midgame/pool.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import { getAttemptsForPosition, saveAttempt } from './attemptsStore.ts'
import { judgeVerbalization, type JudgeVerbalizationResult } from './judgeVerbalization.ts'
import { filterPoolBySource, pickProblem } from './pickProblem.ts'
import { findReasonTag, MAX_CHOSEN_TAGS } from './reasonTags.ts'
import { TagPicker } from './TagPicker.tsx'
import type { ProblemSource, VerbalizeAttemptRecord, VerbalizeCaseKind, VerbalizeProblem } from './types.ts'
import './PracticeMode.css'

/**
 * 最善手の探索条件(要件4)。`midgame/PracticeMode.tsx`の`MIDGAME_ANALYZE_LIMIT`と
 * 同じ値(depth16・空き24以下で自動的に完全読みに切り替わる)を使う。長時間ハング対策
 * のため`timeMs`を必ず設定する(T034で発生したハング事故の教訓)。
 *
 * `timeMs`はT076により`MIDGAME_ANALYZE_LIMIT`と同じ理由で`300`→`1000`に
 * 引き上げた(合法手数が多い局面での深さ不足による誤ったランキングを避けるため)。
 */
const VERBALIZE_ANALYZE_LIMIT: AnalyzeLimit = { depth: 16, timeMs: 1000, exactFromEmpties: 24 }

const SOURCE_OPTIONS: readonly { value: ProblemSource; label: string }[] = [
  { value: 'pool', label: '中盤練習プール(全件)' },
  { value: 'myBlunder', label: '自分の悪手局面(棋譜解析/中盤練習で記録した局面)' },
]

const CASE_TITLE: Record<VerbalizeCaseKind, string> = {
  correctBoth: '完全正解',
  correctMoveWrongReason: '正解だが理由が違う',
  wrongMoveCorrectReason: '着眼は正しい',
  wrongBoth: '要復習',
}

const CASE_MESSAGE: Record<VerbalizeCaseKind, string> = {
  correctBoth: '手も理由も正しく捉えられています。',
  correctMoveWrongReason:
    '手は正解でしたが、選んだ理由は実際の最善手の根拠とズレていました。まぐれ当たりの可能性があります。理由タグを宣言したからこそ気づけたポイントです。',
  wrongMoveCorrectReason: '着眼点(理由)は正しいです。その観点で、もう一度最善手を選び直してみましょう。',
  wrongBoth: '手も理由も違いました。関連しそうな概念の簡単な説明を確認してみましょう。',
}

type Phase = 'settings' | 'move' | 'tags' | 'result'

interface ResultData {
  readonly judgement: JudgeVerbalizationResult
  readonly playedMove: string
  readonly bestMove: string
  readonly attribution: AttributionBreakdown
  readonly motifs: readonly MotifDefinition[]
  readonly pastAttempts: readonly VerbalizeAttemptRecord[]
}

/**
 * 言語化トレーニングモード(T035、設計書§6.1)。
 *
 * 1. 出題(要件1): 中盤練習プール(`midgame/pool.ts`)から局面を選び、評価値を
 *    表示せずに提示する(出典のスコープ縮小は`verbalize/types.ts`参照)。
 * 2. 着手(要件2)→理由タグ選択(1〜3個)+自由記述(要件3・6)。
 * 3. 採点(要件4): `judgeMidgameMove`(手の正誤)+`buildAttribution`/`detectMotifs`
 *    (理由の正誤の根拠)を`judgeVerbalization`に渡し、2×2の4ケースを判定する。
 * 4. フィードバック(要件5): 4パターンのメッセージを表示。「手×理由○」は同じ局面で
 *    手だけ選び直せる簡易な再出題、「手×理由×」は該当タグの簡易説明を表示する
 *    (T036用語集が無い現時点の代替)。
 *
 * レスポンシブ対応: 375px幅程度でも崩れないよう`PracticeMode.css`でタグ群・
 * ボタン群を`flex-wrap`させ、狭幅では縦積みにする。
 */
export function PracticeMode() {
  const [source, setSource] = useState<ProblemSource>('pool')
  const [pool, setPool] = useState<MidgamePoolEntry[] | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('settings')
  const [problem, setProblem] = useState<VerbalizeProblem | null>(null)
  const [chosenSquare, setChosenSquare] = useState<number | null>(null)
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')
  const [isReattempt, setIsReattempt] = useState(false)

  const [judging, setJudging] = useState(false)
  const [judgeError, setJudgeError] = useState<string | null>(null)
  const [resultData, setResultData] = useState<ResultData | null>(null)

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

  function startProblem(): void {
    if (!pool) return
    const next = pickProblem(pool, source)
    if (!next) return
    setProblem(next)
    setChosenSquare(null)
    setChosenTags([])
    setFreeText('')
    setIsReattempt(false)
    setResultData(null)
    setJudgeError(null)
    setPhase('move')
  }

  /**
   * 手の正誤・理由の正誤を判定し、挑戦記録を保存する(要件4・6)。
   * `tags`/`text`は「手×理由○」の再出題(要件5)でも同じ値を使い回せるよう
   * 引数として明示的に受け取る。
   */
  async function finalizeAndJudge(square: number, tags: readonly string[], text: string): Promise<void> {
    if (!problem) return
    setJudging(true)
    setJudgeError(null)
    try {
      const engine = getEngine()
      const playedNotation = squareToNotation(square)
      const allMoves = await engine.requestAnalyzeAll(problem.board, problem.sideToMove, VERBALIZE_ANALYZE_LIMIT)
      const moveJudgement = judgeMidgameMove({ mode: 'standard', allMoves, playedMove: playedNotation })

      if (!moveJudgement.bestMove) {
        setJudgeError('この局面の評価取得に失敗しました。')
        return
      }
      const bestMove = moveJudgement.bestMove
      const bestSquare = notationToSquare(bestMove)
      const boardAfterBest = applyMove(problem.board, problem.sideToMove, bestSquare)
      const opponentSide = opposite(problem.sideToMove)

      const [beforeTerms, afterTerms, featureResp, pastAttempts] = await Promise.all([
        engine.requestEvalTerms(problem.board, problem.sideToMove),
        engine.requestEvalTerms(boardAfterBest, opponentSide),
        engine.requestFeatureSet(problem.board, problem.sideToMove, bestMove),
        getAttemptsForPosition(problem.positionKey),
      ])

      const attribution = buildAttribution(afterTerms, beforeTerms, problem.sideToMove)
      const motifs = detectMotifs({
        beforeBoard: problem.board,
        side: problem.sideToMove,
        square: bestSquare,
        features: featureResp.features,
      })

      const judgement = judgeVerbalization({
        moveCorrect: moveJudgement.correct,
        chosenTags: tags,
        attribution,
        motifs,
      })

      const record: VerbalizeAttemptRecord = {
        id: `verbalize-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        positionKey: problem.positionKey,
        sideToMove: problem.sideToMove,
        chosenMove: playedNotation,
        chosenTags: [...tags],
        freeText: text,
        caseKind: judgement.caseKind,
        createdAt: new Date().toISOString(),
      }
      await saveAttempt(record)

      setChosenSquare(square)
      setResultData({ judgement, playedMove: playedNotation, bestMove, attribution, motifs, pastAttempts })
      setPhase('result')
    } catch (error) {
      console.error('判定に失敗しました', error)
      setJudgeError('判定に失敗しました。もう一度お試しください。')
    } finally {
      setJudging(false)
    }
  }

  function handleMoveSelected(square: number): void {
    setChosenSquare(square)
    if (isReattempt) {
      void finalizeAndJudge(square, chosenTags, freeText)
      return
    }
    setPhase('tags')
  }

  function toggleTag(id: string): void {
    setChosenTags((prev) => {
      if (prev.includes(id)) return prev.filter((t) => t !== id)
      if (prev.length >= MAX_CHOSEN_TAGS) return prev
      return [...prev, id]
    })
  }

  function handleTagsSubmit(): void {
    if (chosenSquare === null) return
    if (chosenTags.length < 1 || chosenTags.length > MAX_CHOSEN_TAGS) return
    void finalizeAndJudge(chosenSquare, chosenTags, freeText)
  }

  /** 「手×理由○」: 着眼(タグ・自由記述)は維持したまま、同じ局面で手だけ選び直す(要件5)。 */
  function retrySameProblem(): void {
    setIsReattempt(true)
    setChosenSquare(null)
    setResultData(null)
    setJudgeError(null)
    setPhase('move')
  }

  function nextProblem(): void {
    startProblem()
  }

  function backToSettings(): void {
    setPhase('settings')
    setProblem(null)
    setChosenSquare(null)
    setChosenTags([])
    setFreeText('')
    setIsReattempt(false)
    setResultData(null)
    setJudgeError(null)
  }

  return (
    <div class="verbalize-practice-mode">
      {poolError && <p class="notice notice--error">{poolError}</p>}

      {phase === 'settings' && (
        <section class="verbalize-settings">
          <p>言語化トレーニング: 局面の出典を選んで開始してください</p>

          <fieldset class="verbalize-settings__group">
            <legend>出典</legend>
            {SOURCE_OPTIONS.map(({ value, label }) => (
              <label class="verbalize-settings__option" key={value}>
                <input
                  type="radio"
                  name="verbalize-source"
                  value={value}
                  checked={source === value}
                  onChange={() => setSource(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          {pool === null && !poolError && <p class="notice">出題プールを読み込み中...</p>}
          {pool !== null && filteredCount === 0 && (
            <p class="notice">
              出題プールが空です。中盤練習モードで何度か失敗するか、棋譜解析モードで悪手を「中盤練習に送る」から局面を蓄積してください。
            </p>
          )}

          <button type="button" disabled={pool === null || filteredCount === 0} onClick={startProblem}>
            開始
          </button>
        </section>
      )}

      {(phase === 'move' || phase === 'tags') && problem && (
        <section class="verbalize-problem">
          <p class="status">
            {isReattempt
              ? '同じ局面で、正しい着眼点のまま手を選び直してください。'
              : '評価値は表示されません。最善だと思う手を選んでください。'}
          </p>

          <div class="board-container">
            <Board
              board={problem.board}
              sideToMove={problem.sideToMove}
              lastMove={chosenSquare}
              onMove={phase === 'move' ? handleMoveSelected : undefined}
            />
          </div>

          {judging && <p class="notice">判定中...</p>}
          {judgeError && <p class="notice notice--error">{judgeError}</p>}

          {phase === 'tags' && chosenSquare !== null && (
            <div class="verbalize-tags">
              <p>
                選んだ手: {squareToNotation(chosenSquare)}(
                <button type="button" class="verbalize-tags__reselect" onClick={() => setPhase('move')}>
                  選び直す
                </button>
                )
              </p>
              <p>
                理由タグを1〜3個選んでください({chosenTags.length}/{MAX_CHOSEN_TAGS})
              </p>

              <TagPicker chosenTags={chosenTags} onToggle={toggleTag} />

              <label class="verbalize-tags__freetext">
                自由記述メモ(任意)
                <textarea
                  value={freeText}
                  onInput={(event) => setFreeText((event.target as HTMLTextAreaElement).value)}
                  rows={3}
                  placeholder="なぜこの手を選んだか、自分の言葉でメモしておきましょう"
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
              正しい理由タグ(最善手の根拠):{' '}
              {resultData.judgement.targetTags.map((id) => findReasonTag(id)?.label ?? id).join('、') ||
                '(明確な単一の根拠は検出されませんでした)'}
            </p>
          </div>

          <AttributionWaterfall breakdown={resultData.attribution} title="最善手を選んだ場合の評価内訳(石差)" />

          {resultData.motifs.length > 0 && (
            <ul class="verbalize-result__motifs">
              {resultData.motifs.map((motif) => (
                <li key={motif.key} class={`motif-badge motif-badge--${motif.kind}`}>
                  {motif.label}
                </li>
              ))}
            </ul>
          )}

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
              <button type="button" onClick={retrySameProblem}>
                同じ局面でもう一度手を選ぶ
              </button>
            )}
            <button type="button" onClick={nextProblem}>
              次の問題へ
            </button>
            <button type="button" onClick={backToSettings}>
              設定に戻る
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
