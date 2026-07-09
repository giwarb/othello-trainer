import { findGlossaryEntry } from './glossary.ts'
import { GlossaryEntryDetail } from './GlossaryEntryDetail.tsx'
import type { GlossaryExampleEngine } from './glossaryExamples.ts'
import './GlossaryPopover.css'

export interface GlossaryPopoverProps {
  readonly tagId: string
  readonly engine: GlossaryExampleEngine
  readonly onClose: () => void
}

/**
 * 用語集詳細を軽量なオーバーレイで表示する(要件2「1タップ導線」)。
 * `BlunderPanel`(モチーフバッジ)・`TwoChoiceDrill`(理由タグ選択UI、`TagPicker`の
 * 情報ボタン)から、モード/タブを切り替えずその場で用語集詳細を確認できるようにする。
 * 該当する用語集項目が無ければ何も表示しない(呼び出し側の防御的チェック漏れの保険)。
 */
export function GlossaryPopover({ tagId, engine, onClose }: GlossaryPopoverProps) {
  const entry = findGlossaryEntry(tagId)
  if (!entry) return null

  return (
    <div class="glossary-popover-overlay" role="presentation" onClick={onClose}>
      <div
        class="glossary-popover"
        role="dialog"
        aria-modal="true"
        aria-label={`用語集: ${entry.label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" class="glossary-popover__close" onClick={onClose}>
          閉じる
        </button>
        <GlossaryEntryDetail entry={entry} engine={engine} />
      </div>
    </div>
  )
}
