import { useEffect, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { getAllPoolEntries } from '../midgame/pool.ts'
import type { MidgamePoolEntry } from '../midgame/types.ts'
import { saveAttempt } from './attemptsStore.ts'
import type { GlossaryEntry } from './glossary.ts'
import { judgeVerbalization, type JudgeVerbalizationResult } from './judgeVerbalization.ts'
import { findReasonTag, MAX_CHOSEN_TAGS } from './reasonTags.ts'
import { TagPicker } from './TagPicker.tsx'
import { buildDrillProblem, type DrillEngine, type DrillProblem } from './TwoChoiceDrill.tsx'
import type { VerbalizeAttemptRecord } from './types.ts'
import './PracticeMode.css'
import './TwoChoiceDrill.css'
import './ConceptLesson.css'

/** 1レッスンの問題数(要件3、設計書§7「説明1画面+二択ドリル10問」)。 */
const LESSON_LENGTH = 10

export interface ConceptLessonProps {
  readonly entry: GlossaryEntry
  readonly engine: DrillEngine
  readonly onExit: () => void
}

type Phase = 'intro' | 'loading' | 'choosing' | 'tags' | 'result' | 'summary' | 'notFound'

interface QuestionResult {
  readonly judgement: JudgeVerbalizationResult
}

/**
 * T036要件3「概念レッスン」。用語集1項目の説明画面 + その概念に絞り込んだ
 * 二択比較ドリル`LESSON_LENGTH`問で構成する(設計書§7)。
 *
 * `TwoChoiceDrill.tsx`(T035)が出題選択・判定に使う`buildDrillProblem`
 * (`requiredTagId`オプションでこのレッスンの概念に絞り込む)・`judgeVerbalization`・
 * `TagPicker`・`saveAttempt`をそのまま再利用する(要件3「TwoChoiceDrillを特定タグに
 * 絞り込んで再利用する」、ロジックの二重管理を避けるための設計)。
 */
export function ConceptLesson({ entry, engine, onExit }: ConceptLessonProps) {
  const [pool, setPool] = useState<MidgamePoolEntry[] | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('intro')
  const [questionIndex, setQuestionIndex] = useState(0)
  const [results, setResults] = useState<QuestionResult[]>([])

  const [drillProblem, setDrillProblem] = useState<DrillProblem | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [chosenMove, setChosenMove] = useState<string | null>(null)
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [judging, setJudging] = useState(false)
  const [judgeError, setJudgeError] = useState<string | null>(null)
  const [currentJudgement, setCurrentJudgement] = useState<JudgeVerbalizationResult | null>(null)

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

  async function loadNextQuestion(): Promise<void> {
    if (!pool) return
    setPhase('loading')
    setBuildError(null)
    try {
      const drill = await buildDrillProblem(engine, pool, 'pool', Math.random, { requiredTagId: entry.key })
      if (!drill) {
        setPhase('notFound')
        return
      }
      setDrillProblem(drill)
      setChosenMove(null)
      setChosenTags([])
      setCurrentJudgement(null)
      setJudgeError(null)
      setPhase('choosing')
    } catch (error) {
      console.error('概念レッスンの局面生成に失敗しました', error)
      setBuildError('局面生成に失敗しました。もう一度お試しください。')
      setPhase('intro')
    }
  }

  function startLesson(): void {
    setQuestionIndex(0)
    setResults([])
    void loadNextQuestion()
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

  async function submitAnswer(): Promise<void> {
    if (!drillProblem || !chosenMove) return
    setJudging(true)
    setJudgeError(null)
    try {
      const moveCorrect = chosenMove === drillProblem.bestMove
      const judgement = judgeVerbalization({
        moveCorrect,
        chosenTags,
        attribution: drillProblem.attribution,
        motifs: drillProblem.motifs,
      })
      const record: VerbalizeAttemptRecord = {
        id: `verbalize-lesson-${entry.key}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        positionKey: drillProblem.problem.positionKey,
        sideToMove: drillProblem.problem.sideToMove,
        chosenMove,
        chosenTags: [...chosenTags],
        freeText: '',
        caseKind: judgement.caseKind,
        createdAt: new Date().toISOString(),
      }
      await saveAttempt(record)
      setCurrentJudgement(judgement)
      setResults((prev) => [...prev, { judgement }])
      setPhase('result')
    } catch (error) {
      console.error('判定に失敗しました', error)
      setJudgeError('判定に失敗しました。もう一度お試しください。')
    } finally {
      setJudging(false)
    }
  }

  function nextQuestion(): void {
    const completed = questionIndex + 1
    setQuestionIndex(completed)
    if (completed >= LESSON_LENGTH) {
      setPhase('summary')
      return
    }
    void loadNextQuestion()
  }

  const correctMoveCount = results.filter((r) => r.judgement.moveCorrect).length
  const correctReasonCount = results.filter((r) => r.judgement.reasonCorrect).length

  return (
    <div class="verbalize-practice-mode two-choice-drill concept-lesson">
      <button type="button" class="concept-lesson__exit" onClick={onExit}>
        ← 用語集に戻る
      </button>

      {phase === 'intro' && (
        <section class="verbalize-settings">
          <h3>{entry.label}</h3>
          <p>{entry.definition}</p>
          <p class="status">
            二択ドリル{LESSON_LENGTH}問に挑戦します(「{entry.label}」が根拠になる局面を優先して出題します)。
          </p>
          {poolError && <p class="notice notice--error">{poolError}</p>}
          {buildError && <p class="notice notice--error">{buildError}</p>}
          <button type="button" disabled={pool === null} onClick={startLesson}>
            開始
          </button>
        </section>
      )}

      {phase === 'loading' && <p class="notice">「{entry.label}」に関する局面を探しています...</p>}

      {phase === 'notFound' && (
        <section class="verbalize-settings">
          <p class="notice">
            「{entry.label}」が根拠になる局面が出題プール内に見つかりませんでした。中盤練習・棋譜解析で局面を増やしてから再度お試しください。
          </p>
          <button type="button" onClick={onExit}>
            用語集に戻る
          </button>
        </section>
      )}

      {(phase === 'choosing' || phase === 'tags') && drillProblem && (
        <section class="verbalize-problem">
          <p class="status">
            {questionIndex + 1}/{LESSON_LENGTH}問目。評価値は表示されません。どちらの手が良いか選んでください。
          </p>

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

              <TagPicker chosenTags={chosenTags} onToggle={toggleTag} />

              <div class="verbalize-tags__buttons">
                <button
                  type="button"
                  disabled={chosenTags.length < 1 || chosenTags.length > MAX_CHOSEN_TAGS || judging}
                  onClick={() => void submitAnswer()}
                >
                  {judging ? '採点中...' : '採点する'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {phase === 'result' && currentJudgement && drillProblem && (
        <section class={`verbalize-result verbalize-result--${currentJudgement.caseKind}`}>
          <p>
            あなたの手: {chosenMove}
            {currentJudgement.moveCorrect ? '(正解)' : `(不正解、正解手: ${drillProblem.bestMove})`}
          </p>
          <p>選んだ理由タグ: {chosenTags.map((id) => findReasonTag(id)?.label ?? id).join('、') || '(なし)'}</p>
          <p>理由の判定: {currentJudgement.reasonCorrect ? '正解' : '不正解'}</p>
          <button type="button" onClick={nextQuestion}>
            {questionIndex + 1 >= LESSON_LENGTH ? '結果を見る' : '次の問題へ'}
          </button>
        </section>
      )}

      {phase === 'summary' && (
        <section class="verbalize-result concept-lesson__summary">
          <h3>「{entry.label}」レッスン結果</h3>
          <p>
            手の正答: {correctMoveCount}/{results.length}問
          </p>
          <p>
            理由の正答: {correctReasonCount}/{results.length}問
          </p>
          <div class="concept-lesson__buttons">
            <button type="button" onClick={startLesson}>
              もう一度挑戦する
            </button>
            <button type="button" onClick={onExit}>
              用語集に戻る
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
