import { useEffect, useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import { getAllPoolEntries } from '../midgame/pool.ts'
import { GLOSSARY_CATEGORY_LABEL, type GlossaryEntry } from './glossary.ts'
import { findGlossaryExamples, type GlossaryExample, type GlossaryExampleEngine } from './glossaryExamples.ts'
import './GlossaryEntryDetail.css'

export interface GlossaryEntryDetailProps {
  readonly entry: GlossaryEntry
  readonly engine: GlossaryExampleEngine
  /** 概念レッスンへの導線(要件3)。渡された場合のみボタンを表示する。 */
  readonly onStartLesson?: () => void
}

function sideLabel(side: 'black' | 'white'): string {
  return side === 'black' ? '黒' : '白'
}

function ExampleBoard({ example, caption }: { readonly example: GlossaryExample; readonly caption: string }) {
  return (
    <div class="glossary-entry-detail__example">
      <div class="board-container glossary-entry-detail__board">
        <Board board={example.board} sideToMove={example.side} lastMove={example.square} />
      </div>
      <p class="glossary-entry-detail__example-caption">{caption}</p>
    </div>
  )
}

/**
 * 用語集1項目ぶんの詳細表示(要件1・2)。`GlossaryPage`(用語集ページ本体)・
 * `BlunderPanel`(モチーフバッジからの1タップ導線)・`TagPicker`(理由タグ選択UIからの
 * 1タップ導線)のいずれからも同じコンポーネントを再利用する(ロジックの二重管理を
 * 避けるため)。
 *
 * 例局面・反例局面は出題プール(`midgame/pool.ts`)から`glossaryExamples.ts`が
 * 実行時に検索する(`glossary.ts`冒頭コメント参照)。プールが空、または見つからない
 * 場合はその旨を表示するのみでエラーにはしない。
 */
export function GlossaryEntryDetail({ entry, engine, onStartLesson }: GlossaryEntryDetailProps) {
  const [examples, setExamples] = useState<readonly GlossaryExample[] | null>(null)
  const [counterexample, setCounterexample] = useState<GlossaryExample | null>(null)
  const [searching, setSearching] = useState(true)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [poolEmpty, setPoolEmpty] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    setExamples(null)
    setCounterexample(null)
    setPoolEmpty(false)

    async function run(): Promise<void> {
      try {
        const poolEntries = await getAllPoolEntries()
        if (cancelled) return
        if (poolEntries.length === 0) {
          setPoolEmpty(true)
          setExamples([])
          return
        }
        const result = await findGlossaryExamples(engine, poolEntries, entry)
        if (cancelled) return
        setExamples(result.examples)
        setCounterexample(result.counterexample)
      } catch (error) {
        console.error('用語集の例局面検索に失敗しました', error)
        if (!cancelled) setSearchError('例局面の検索に失敗しました。')
      } finally {
        if (!cancelled) setSearching(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // entryが変わるたびに検索し直す(engineはコンポーネント生存期間中不変)。
    // eslint-disable-next-line
  }, [entry.key])

  return (
    <div class="glossary-entry-detail">
      <div class="glossary-entry-detail__header">
        <span class={`glossary-entry-detail__badge glossary-entry-detail__badge--${entry.category}`}>
          {GLOSSARY_CATEGORY_LABEL[entry.category]}
        </span>
        <h3 class="glossary-entry-detail__label">{entry.label}</h3>
      </div>

      <p class="glossary-entry-detail__definition">{entry.definition}</p>

      {onStartLesson && (
        <button type="button" class="glossary-entry-detail__lesson-button" onClick={onStartLesson}>
          この概念のレッスンを始める(二択ドリル10問)
        </button>
      )}

      <div class="glossary-entry-detail__examples">
        {searching && <p class="notice">例局面を検索中...</p>}
        {searchError && <p class="notice notice--error">{searchError}</p>}
        {poolEmpty && (
          <p class="notice">
            出題プールが空のため例局面を表示できません。中盤練習・棋譜解析モードで局面を蓄積してください。
          </p>
        )}

        {examples && examples.length > 0 && (
          <div class="glossary-entry-detail__example-group">
            <p class="glossary-entry-detail__example-group-title">例局面(該当する手: 印付きのマス)</p>
            {examples.map((ex, i) => (
              <ExampleBoard key={i} example={ex} caption={`${sideLabel(ex.side)}番の局面`} />
            ))}
          </div>
        )}
        {examples && examples.length === 0 && !poolEmpty && !searching && !searchError && (
          <p class="notice">条件に合う例局面が見つかりませんでした(出題プールを増やすと見つかりやすくなります)。</p>
        )}

        {counterexample && (
          <div class="glossary-entry-detail__example-group">
            <p class="glossary-entry-detail__example-group-title">反例局面(該当しない手: 印付きのマス)</p>
            <ExampleBoard example={counterexample} caption={`${sideLabel(counterexample.side)}番の局面`} />
          </div>
        )}
      </div>
    </div>
  )
}
