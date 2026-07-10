import { useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import type { Side } from '../game/othello.ts'
import { AttributionWaterfall } from './AttributionWaterfall.tsx'
import {
  describeRefutationStep,
  REFUTATION_LINE_LABEL,
  REFUTATION_THRESHOLD_DISCS,
  type RefutationLine,
  type RefutationLineKey,
  type RefutationResult,
} from './refutation.ts'
import type { AttributionTerm } from './types.ts'
import './RefutationView.css'

export interface RefutationViewProps {
  /** `refutation.ts`の`buildRefutationResult`が返す検出結果。 */
  readonly refutation: RefutationResult
  /** 評価内訳の項目ラベルクリック時(用語集起動、T058要件4)。省略可。 */
  readonly onSelectTerm?: (key: AttributionTerm['key']) => void
}

const LINE_KEYS: readonly RefutationLineKey[] = ['played', 'best']

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

interface RefutationLineColumnProps {
  readonly lineKey: RefutationLineKey
  readonly line: RefutationLine
  readonly stepIndex: number
  readonly onStepIndexChange: (next: number) => void
  readonly onSelectTerm?: (key: AttributionTerm['key']) => void
}

/**
 * 反証層の一方の系列(実際の進行/最善進行)ぶんの列。`RefutationView`が
 * 両系列を横並びに(要件3、T058)描画するために抽出した(タブ切替時代の
 * 単一列表示ロジックをそのまま列として再利用している)。
 */
function RefutationLineColumn({ lineKey, line, stepIndex, onStepIndexChange, onSelectTerm }: RefutationLineColumnProps) {
  const steps = line.steps
  const idx = steps.length === 0 ? 0 : Math.min(stepIndex, steps.length - 1)
  const currentStep = steps[idx] ?? null
  const criticalSteps = steps.filter((step) => step.isCriticalPly)

  return (
    <div class="refutation-view__column">
      <h4 class="refutation-view__column-title">{REFUTATION_LINE_LABEL[lineKey]}</h4>

      {steps.length === 0 && <p class="notice">この進行には比較できる手がありません。</p>}

      {steps.length > 0 && currentStep && (
        <>
          <div class="refutation-view__stepper">
            <button type="button" disabled={idx === 0} onClick={() => onStepIndexChange(Math.max(0, idx - 1))}>
              前へ
            </button>
            <span class="refutation-view__step-label">
              {idx + 1} / {steps.length}手目: {currentStep.move}
              {currentStep.mover && `(${sideLabel(currentStep.mover)}番)`}
              {currentStep.isCriticalPly && <span class="refutation-view__critical-badge">回収点</span>}
            </span>
            <button
              type="button"
              disabled={idx === steps.length - 1}
              onClick={() => onStepIndexChange(Math.min(steps.length - 1, idx + 1))}
            >
              次へ
            </button>
          </div>

          <div class="board-container refutation-view__board">
            <Board board={currentStep.board} sideToMove={currentStep.sideToMoveAfter ?? currentStep.mover ?? 'black'} />
          </div>
          <AttributionWaterfall
            breakdown={currentStep.breakdown}
            title={`${idx + 1}手目(${currentStep.move})時点の寄与変化(直前の局面との差)`}
            onSelectTerm={onSelectTerm}
          />

          {currentStep.isCriticalPly && (
            <p class="notice refutation-view__critical-text">
              {describeRefutationStep(REFUTATION_LINE_LABEL[lineKey], currentStep)}
            </p>
          )}
        </>
      )}

      <div class="refutation-view__critical-list">
        <h5>検出された回収点</h5>
        {criticalSteps.length === 0 && (
          <p class="notice">この進行では閾値({REFUTATION_THRESHOLD_DISCS}石)を超える寄与変化は検出されませんでした。</p>
        )}
        {criticalSteps.length > 0 && (
          <ul class="refutation-view__critical-items">
            {criticalSteps.map((step) => (
              <li key={step.stepIndex}>
                <button type="button" onClick={() => onStepIndexChange(step.stepIndex)}>
                  {describeRefutationStep(REFUTATION_LINE_LABEL[lineKey], step)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * 反証層(T033、`othello-trainer-design-verbalization.md` §3)の表示コンポーネント。
 *
 * 比較PV(T030)の「実際の進行」「最善進行」を、タブ切替ではなく2列を横並びに
 * (狭い画面では縦積みに)常時両方表示し、それぞれ独立に1手ずつ進める・戻す
 * ステップ実行UIを提供する(T058要件3「タブ切替よりも分かりやすい形」対応。
 * 以前はどちらか一方の系列しか見えなかったが、この変更により両方を同時に
 * 見比べられる)。各ステップで局面・評価内訳分解(T031の`AttributionWaterfall`
 * を再利用)・回収点かどうかをあわせて表示する。検出済みの回収点は一覧としても
 * 表示し、クリックでそのステップへジャンプできる。
 *
 * レスポンシブ対応: 375px幅では2列を縦積みにし、横スクロールが発生しない
 * ようにする(`RefutationView.css`のメディアクエリ参照)。
 */
export function RefutationView({ refutation, onSelectTerm }: RefutationViewProps) {
  const [stepIndexByLine, setStepIndexByLine] = useState<Record<RefutationLineKey, number>>({ played: 0, best: 0 })

  return (
    <div class="refutation-view">
      <p class="refutation-view__intro">
        比較PVを1手ずつたどり、評価内訳(モビリティ/隅/確定石)の寄与が1手あたり{REFUTATION_THRESHOLD_DISCS}
        石以上動いた手を「回収点」として検出します。実際の進行/最善進行を並べて見比べられます。
      </p>

      <div class="refutation-view__columns">
        {LINE_KEYS.map((key) => (
          <RefutationLineColumn
            key={key}
            lineKey={key}
            line={refutation[key]}
            stepIndex={stepIndexByLine[key]}
            onStepIndexChange={(next) => setStepIndexByLine((prev) => ({ ...prev, [key]: next }))}
            onSelectTerm={onSelectTerm}
          />
        ))}
      </div>
    </div>
  )
}
