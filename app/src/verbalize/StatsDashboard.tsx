import { useEffect, useState } from 'preact/hooks'
import { getAllAttempts } from './attemptsStore.ts'
import {
  computeConceptStats,
  moveAccuracy,
  pickWeakestConcept,
  reasonAccuracy,
  sortByWeakness,
  type ConceptStat,
} from './conceptStats.ts'
import { findGlossaryEntry } from './glossary.ts'
import './StatsDashboard.css'

function labelFor(tagId: string): string {
  return findGlossaryEntry(tagId)?.label ?? tagId
}

function formatPercent(ratio: number | null): string {
  return ratio === null ? '-' : `${Math.round(ratio * 100)}%`
}

function AccuracyBar({ label, ratio }: { readonly label: string; readonly ratio: number | null }) {
  const widthPercent = ratio === null ? 0 : Math.round(ratio * 100)
  return (
    <div class="stats-dashboard__bar-row">
      <span class="stats-dashboard__bar-label">{label}</span>
      <span class="stats-dashboard__bar-track">
        <span class="stats-dashboard__bar-fill" style={{ width: `${widthPercent}%` }} />
      </span>
      <span class="stats-dashboard__bar-value">{formatPercent(ratio)}</span>
    </div>
  )
}

/**
 * 概念別弱点統計ダッシュボード(T036要件4・5、設計書§8)。
 *
 * 集計源は`verbalizeAttempts`(T035)のみ(`glossary.ts`・`conceptStats.ts`冒頭コメント
 * 参照)。可視化はレーダーチャート等を新規導入せず、`analysis/AttributionWaterfall.tsx`
 * (T031)と同じ「横棒(バー)」形式を踏襲する(タスク仕様「本タスクでのスコープ縮小」3)。
 */
export function StatsDashboard() {
  const [stats, setStats] = useState<Map<string, ConceptStat> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAllAttempts()
      .then((records) => {
        if (!cancelled) setStats(computeConceptStats(records))
      })
      .catch((err: unknown) => {
        console.error('統計の集計に失敗しました', err)
        if (!cancelled) setError('統計の集計に失敗しました。ページを再読み込みしてください。')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p class="notice notice--error">{error}</p>
  if (!stats) return <p class="notice">統計を集計中...</p>

  const sorted = sortByWeakness(stats)
  const totalAttempts = sorted.reduce((sum, s) => sum + s.attempts, 0)
  const weakest = pickWeakestConcept(stats)

  return (
    <div class="stats-dashboard">
      <p class="status">
        言語化トレーニングの挑戦記録: {totalAttempts}回(概念タグ{sorted.length}種類)
      </p>

      {sorted.length === 0 && (
        <p class="notice">
          まだ言語化トレーニング(出題+理由タグ選択、または二択比較ドリル)の記録がありません。挑戦すると、ここに概念別の弱点が表示されます。
        </p>
      )}

      {weakest && (
        <p class="stats-dashboard__summary">
          最も弱い概念は「{labelFor(weakest.tagId)}」です(理由正答率{formatPercent(reasonAccuracy(weakest))}、
          {weakest.attempts}回中)。
        </p>
      )}

      {sorted.length > 0 && (
        <ul class="stats-dashboard__list">
          {sorted.map((stat) => (
            <li key={stat.tagId} class="stats-dashboard__item">
              <p class="stats-dashboard__item-title">
                {labelFor(stat.tagId)}({stat.attempts}回、最終挑戦: {stat.lastSeen.slice(0, 10)})
              </p>
              <AccuracyBar label="手の正答率" ratio={moveAccuracy(stat)} />
              <AccuracyBar label="理由の正答率" ratio={reasonAccuracy(stat)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
