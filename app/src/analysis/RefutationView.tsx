import { useState } from 'preact/hooks'
import { Board } from '../components/Board.tsx'
import type { Side } from '../game/othello.ts'
import { AttributionWaterfall } from './AttributionWaterfall.tsx'
import {
  describeRefutationStep,
  REFUTATION_LINE_LABEL,
  REFUTATION_THRESHOLD_DISCS,
  type RefutationLineKey,
  type RefutationResult,
  type RefutationStep,
} from './refutation.ts'
import './RefutationView.css'

export interface RefutationViewProps {
  /** `refutation.ts`の`buildRefutationResult`が返す検出結果。 */
  readonly refutation: RefutationResult
}

const LINE_KEYS: readonly RefutationLineKey[] = ['played', 'best']

function sideLabel(side: Side): string {
  return side === 'black' ? '黒' : '白'
}

/**
 * 反証層(T033、`othello-trainer-design-verbalization.md` §3)の表示コンポーネント。
 *
 * 比較PV(T030)の「実際の進行」「最善進行」を切り替えつつ、比較PVを1手ずつ
 * 進める・戻すステップ実行UIを提供する。各ステップで局面・評価内訳分解
 * (T031の`AttributionWaterfall`を再利用)・回収点かどうかをあわせて表示する。
 * 検出済みの回収点は一覧としても表示し、クリックでそのステップへジャンプできる。
 *
 * レスポンシブ対応: 375px幅でも横スクロールが発生しないよう、盤面・操作
 * ボタン・波及グラフを縦積みにする(`RefutationView.css`参照)。
 */
export function RefutationView({ refutation }: RefutationViewProps) {
  const [line, setLine] = useState<RefutationLineKey>('played')
  const [stepIndexByLine, setStepIndexByLine] = useState<Record<RefutationLineKey, number>>({ played: 0, best: 0 })

  const steps = refutation[line].steps
  const stepIndex = steps.length === 0 ? 0 : Math.min(stepIndexByLine[line], steps.length - 1)
  const currentStep: RefutationStep | null = steps[stepIndex] ?? null
  const criticalSteps = steps.filter((step) => step.isCriticalPly)

  function setStepIndex(next: number): void {
    setStepIndexByLine((prev) => ({ ...prev, [line]: next }))
  }

  return (
    <div class="refutation-view">
      <p class="refutation-view__intro">
        比較PVを1手ずつたどり、評価内訳(モビリティ/隅/確定石)の寄与が1手あたり{REFUTATION_THRESHOLD_DISCS}
        石以上動いた手を「回収点」として検出します。
      </p>

      <div class="refutation-view__line-tabs" role="tablist">
        {LINE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={line === key}
            class={`refutation-view__line-tab${line === key ? ' refutation-view__line-tab--active' : ''}`}
            onClick={() => setLine(key)}
          >
            {REFUTATION_LINE_LABEL[key]}
          </button>
        ))}
      </div>

      {steps.length === 0 && <p class="notice">この進行には比較できる手がありません。</p>}

      {steps.length > 0 && currentStep && (
        <>
          <div class="refutation-view__stepper">
            <button type="button" disabled={stepIndex === 0} onClick={() => setStepIndex(Math.max(0, stepIndex - 1))}>
              前へ
            </button>
            <span class="refutation-view__step-label">
              {stepIndex + 1} / {steps.length}手目: {currentStep.move}
              {currentStep.mover && `(${sideLabel(currentStep.mover)}番)`}
              {currentStep.isCriticalPly && <span class="refutation-view__critical-badge">回収点</span>}
            </span>
            <button
              type="button"
              disabled={stepIndex === steps.length - 1}
              onClick={() => setStepIndex(Math.min(steps.length - 1, stepIndex + 1))}
            >
              次へ
            </button>
          </div>

          <div class="refutation-view__step-body">
            <div class="board-container refutation-view__board">
              <Board board={currentStep.board} sideToMove={currentStep.sideToMoveAfter ?? currentStep.mover ?? 'black'} />
            </div>
            <AttributionWaterfall
              breakdown={currentStep.breakdown}
              title={`${stepIndex + 1}手目(${currentStep.move})時点の寄与変化(直前の局面との差)`}
            />
          </div>

          {currentStep.isCriticalPly && (
            <p class="notice refutation-view__critical-text">
              {describeRefutationStep(REFUTATION_LINE_LABEL[line], currentStep)}
            </p>
          )}
        </>
      )}

      <div class="refutation-view__critical-list">
        <h4>検出された回収点({REFUTATION_LINE_LABEL[line]})</h4>
        {criticalSteps.length === 0 && (
          <p class="notice">この進行では閾値({REFUTATION_THRESHOLD_DISCS}石)を超える寄与変化は検出されませんでした。</p>
        )}
        {criticalSteps.length > 0 && (
          <ul class="refutation-view__critical-items">
            {criticalSteps.map((step) => (
              <li key={step.stepIndex}>
                <button type="button" onClick={() => setStepIndex(step.stepIndex)}>
                  {describeRefutationStep(REFUTATION_LINE_LABEL[line], step)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
