import { ATTRIBUTION_REASON_TAGS, MAX_CHOSEN_TAGS, MOTIF_REASON_TAGS } from './reasonTags.ts'

export interface TagPickerProps {
  readonly chosenTags: readonly string[]
  readonly onToggle: (id: string) => void
  /**
   * T036要件2「1タップ導線」: 指定した場合、各タグラベルの隣に用語集を開く
   * 「?」ボタンを表示する(省略時はボタンを表示しない、既存の`PracticeMode.tsx`は
   * 未対応のまま据え置く)。
   */
  readonly onInfo?: (id: string) => void
}

/**
 * 理由タグ選択UI(要件3)。`PracticeMode.tsx`・`TwoChoiceDrill.tsx`の両方から使う
 * 共通コンポーネント(タグ一覧の描画ロジックを二重管理しないため切り出した)。
 * スタイルは`PracticeMode.css`の`.verbalize-tags__*`クラスを共用する。
 */
export function TagPicker({ chosenTags, onToggle, onInfo }: TagPickerProps) {
  return (
    <>
      <div class="verbalize-tags__group">
        <p class="verbalize-tags__group-title">評価内訳ベース</p>
        <div class="verbalize-tags__checkboxes">
          {ATTRIBUTION_REASON_TAGS.map((tag) => (
            <label class="verbalize-tags__checkbox" key={tag.id}>
              <input
                type="checkbox"
                checked={chosenTags.includes(tag.id)}
                disabled={!chosenTags.includes(tag.id) && chosenTags.length >= MAX_CHOSEN_TAGS}
                onChange={() => onToggle(tag.id)}
              />
              {tag.label}
              {onInfo && (
                <button
                  type="button"
                  class="verbalize-tags__info"
                  aria-label={`${tag.label}の用語集を見る`}
                  onClick={(event) => {
                    event.preventDefault()
                    onInfo(tag.id)
                  }}
                >
                  ?
                </button>
              )}
            </label>
          ))}
        </div>
      </div>

      <div class="verbalize-tags__group">
        <p class="verbalize-tags__group-title">モチーフ(手筋)ベース</p>
        <div class="verbalize-tags__checkboxes">
          {MOTIF_REASON_TAGS.map((tag) => (
            <label class="verbalize-tags__checkbox" key={tag.id}>
              <input
                type="checkbox"
                checked={chosenTags.includes(tag.id)}
                disabled={!chosenTags.includes(tag.id) && chosenTags.length >= MAX_CHOSEN_TAGS}
                onChange={() => onToggle(tag.id)}
              />
              {tag.label}
              {onInfo && (
                <button
                  type="button"
                  class="verbalize-tags__info"
                  aria-label={`${tag.label}の用語集を見る`}
                  onClick={(event) => {
                    event.preventDefault()
                    onInfo(tag.id)
                  }}
                >
                  ?
                </button>
              )}
            </label>
          ))}
        </div>
      </div>
    </>
  )
}
