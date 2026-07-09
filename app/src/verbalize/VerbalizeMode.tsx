import { useState } from 'preact/hooks'
import { GlossaryPage } from './GlossaryPage.tsx'
import { PracticeMode } from './PracticeMode.tsx'
import { StatsDashboard } from './StatsDashboard.tsx'
import { TwoChoiceDrill } from './TwoChoiceDrill.tsx'
import './VerbalizeMode.css'

type SubMode = 'practice' | 'twoChoice' | 'glossary' | 'stats'

const SUB_MODE_LABEL: Record<SubMode, string> = {
  practice: '出題(手+理由)',
  twoChoice: '二択比較ドリル',
  glossary: '用語集',
  stats: '弱点統計',
}

/**
 * 言語化トレーニングモード(T035/T036)のトップレベルコンポーネント。`app.tsx`の
 * 6タブ目「言語化トレーニング」から表示される。設計書§6.1「出題フロー」
 * (`PracticeMode`)・§6.2「二択比較ドリル」(`TwoChoiceDrill`)・§7「用語集+概念
 * レッスン」(`GlossaryPage`、T036)・§8「概念別弱点統計」(`StatsDashboard`、T036)
 * をサブタブで切り替える(要件7: 既存モードを要件外にしない)。
 */
export function VerbalizeMode() {
  const [subMode, setSubMode] = useState<SubMode>('practice')

  return (
    <div class="verbalize-mode">
      <nav class="verbalize-mode__sub-nav" aria-label="言語化トレーニングのサブモード切り替え">
        {(Object.keys(SUB_MODE_LABEL) as SubMode[]).map((key) => (
          <button
            type="button"
            key={key}
            class={`verbalize-mode__sub-tab${subMode === key ? ' verbalize-mode__sub-tab--active' : ''}`}
            aria-current={subMode === key ? 'page' : undefined}
            onClick={() => setSubMode(key)}
          >
            {SUB_MODE_LABEL[key]}
          </button>
        ))}
      </nav>

      {subMode === 'practice' && <PracticeMode />}
      {subMode === 'twoChoice' && <TwoChoiceDrill />}
      {subMode === 'glossary' && <GlossaryPage />}
      {subMode === 'stats' && <StatsDashboard />}
    </div>
  )
}
