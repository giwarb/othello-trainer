import { useEffect, useRef, useState } from 'preact/hooks'
import { EngineClient } from '../engine/client.ts'
import { ConceptLesson } from './ConceptLesson.tsx'
import { GLOSSARY_CATEGORY_LABEL, GLOSSARY_ENTRIES, findGlossaryEntry, type GlossaryCategory } from './glossary.ts'
import { GlossaryEntryDetail } from './GlossaryEntryDetail.tsx'
import './GlossaryPage.css'

type View = 'list' | 'detail' | 'lesson'

const CATEGORY_ORDER: readonly GlossaryCategory[] = ['motif-good', 'motif-bad', 'motif-trap', 'attribution']

/**
 * 用語集ページ(T036要件1〜3、設計書§7)。一覧 → 詳細(定義+例局面/反例局面) →
 * 概念レッスン(要件3、`ConceptLesson.tsx`)の3画面をローカルstateで切り替える
 * (アプリ全体がルーティングライブラリを使わない既存方針`app.tsx`に合わせる)。
 */
export function GlossaryPage() {
  const [view, setView] = useState<View>('list')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const engineRef = useRef<EngineClient | null>(null)
  function getEngine(): EngineClient {
    if (!engineRef.current) {
      engineRef.current = new EngineClient()
    }
    return engineRef.current
  }
  useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      engineRef.current = null
    }
  }, [])

  const selectedEntry = selectedKey ? findGlossaryEntry(selectedKey) : null

  function openDetail(key: string): void {
    setSelectedKey(key)
    setView('detail')
  }

  if (view === 'lesson' && selectedEntry) {
    return (
      <ConceptLesson entry={selectedEntry} engine={getEngine()} onExit={() => setView('detail')} />
    )
  }

  if (view === 'detail' && selectedEntry) {
    return (
      <div class="glossary-page">
        <button type="button" class="glossary-page__back" onClick={() => setView('list')}>
          ← 用語集一覧に戻る
        </button>
        <GlossaryEntryDetail
          entry={selectedEntry}
          engine={getEngine()}
          onStartLesson={() => setView('lesson')}
        />
      </div>
    )
  }

  return (
    <div class="glossary-page">
      <p class="status">
        言語化支援の用語集(全{GLOSSARY_ENTRIES.length}項目)。タップすると定義・例局面・反例局面を確認できます。
      </p>
      {CATEGORY_ORDER.map((category) => {
        const entries = GLOSSARY_ENTRIES.filter((e) => e.category === category)
        if (entries.length === 0) return null
        return (
          <section class="glossary-page__group" key={category}>
            <h3 class="glossary-page__group-title">{GLOSSARY_CATEGORY_LABEL[category]}</h3>
            <ul class="glossary-page__list">
              {entries.map((entry) => (
                <li key={entry.key}>
                  <button type="button" class="glossary-page__item" onClick={() => openDetail(entry.key)}>
                    {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
