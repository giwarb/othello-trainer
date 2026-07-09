import { useState } from 'preact/hooks'
import { PracticeMode } from './PracticeMode.tsx'
import { TwoChoiceDrill } from './TwoChoiceDrill.tsx'
import './VerbalizeMode.css'

type SubMode = 'practice' | 'twoChoice'

const SUB_MODE_LABEL: Record<SubMode, string> = {
  practice: '出題(手+理由)',
  twoChoice: '二択比較ドリル',
}

/**
 * 言語化トレーニングモード(T035)のトップレベルコンポーネント。`app.tsx`の
 * 6タブ目「言語化トレーニング」から表示される。設計書§6.1「出題フロー」
 * (`PracticeMode`)と§6.2「二択比較ドリル」(`TwoChoiceDrill`)をサブタブで
 * 切り替える(要件7: 二択比較ドリルを要件外にしない)。
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
    </div>
  )
}
