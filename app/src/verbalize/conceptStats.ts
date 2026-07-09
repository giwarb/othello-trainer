/**
 * T036「概念別弱点統計」(`othello-trainer-design-verbalization.md` §8)の集計ロジック。
 *
 * # 集計源についてのスコープ縮小(タスク仕様「本タスクでのスコープ縮小」2参照)
 *
 * 設計書§8は集計源として「悪手分析・中盤練習・言語化トレーニングの全結果」を
 * 挙げるが、中盤練習(T021)・棋譜解析の悪手分析(T029/T030)は現状タグ情報を
 * 永続化する仕組みを持たない(中盤練習の失敗記録`MidgamePoolEntry`にモチーフ
 * タグが無い、悪手分析パネルの表示は都度計算でIndexedDBに保存されない)。
 * これらを対応させるにはIndexedDBスキーマ・記録経路の追加改修が必要になり、
 * タスク仕様が「現状の記録の仕組みを大きく改修する必要がある場合は無理をせず」
 * 許容している範囲を超えるため、本タスクでは`verbalizeAttempts`(T035、
 * `attemptsStore.ts`)のみを集計源とする。
 *
 * # タグ別の正誤の求め方についての注記
 *
 * `VerbalizeAttemptRecord`は「選んだタグ(`chosenTags`)」と「判定結果
 * (`caseKind`)」のみを保存し、どのタグが実際に正解の根拠と一致したか
 * (`matchedTags`)までは永続化していない(`judgeVerbalization.ts`が返す
 * `matchedTags`はその場限りの表示にのみ使われ、保存対象ではない)。そのため
 * 本モジュールは「1回の挑戦で選んだ全タグに対して、その挑戦全体の正誤
 * (`moveCorrect`/`reasonCorrect`)を均等に反映する」近似で集計する。これは
 * 個々のタグの正誤を厳密に区別できない粗い近似だが、要件4が求める
 * 「挑戦数・正答数(手の正誤)・理由正答数・最終挑戦日」を`verbalizeAttempts`
 * だけから求められる範囲で妥当に近似する現実的な選択である。
 */

import type { VerbalizeCaseKind, VerbalizeAttemptRecord } from './types.ts'

/** 1タグぶんの弱点統計(要件4)。設計書§8の`conceptStat`構造に対応する
 * (「due」フィールドはSRSスケジューリング用で本タスクの要件4には含まれないため省略)。
 */
export interface ConceptStat {
  readonly tagId: string
  readonly attempts: number
  readonly correct: number
  readonly reasonCorrect: number
  /** 最終挑戦日時(ISO文字列、`VerbalizeAttemptRecord.createdAt`のうち最新のもの)。 */
  readonly lastSeen: string
}

/** `caseKind`から「手が正解だったか」を導出する。 */
export function isMoveCorrect(caseKind: VerbalizeCaseKind): boolean {
  return caseKind === 'correctBoth' || caseKind === 'correctMoveWrongReason'
}

/** `caseKind`から「理由(選んだタグ)が正解だったか」を導出する。 */
export function isReasonCorrect(caseKind: VerbalizeCaseKind): boolean {
  return caseKind === 'correctBoth' || caseKind === 'wrongMoveCorrectReason'
}

/**
 * `records`(`verbalizeAttempts`ストアの全件)から、タグごとの`ConceptStat`を集計する
 * 純粋関数(要件4・要件8)。1回の挑戦につき、選んだ全タグ(`chosenTags`)それぞれに
 * 1回ずつ加算する。
 */
export function computeConceptStats(records: readonly VerbalizeAttemptRecord[]): Map<string, ConceptStat> {
  const acc = new Map<string, { attempts: number; correct: number; reasonCorrect: number; lastSeen: string }>()

  for (const record of records) {
    const moveCorrect = isMoveCorrect(record.caseKind)
    const reasonCorrect = isReasonCorrect(record.caseKind)
    for (const tagId of record.chosenTags) {
      const cur = acc.get(tagId) ?? { attempts: 0, correct: 0, reasonCorrect: 0, lastSeen: record.createdAt }
      cur.attempts += 1
      if (moveCorrect) cur.correct += 1
      if (reasonCorrect) cur.reasonCorrect += 1
      if (record.createdAt > cur.lastSeen) cur.lastSeen = record.createdAt
      acc.set(tagId, cur)
    }
  }

  const result = new Map<string, ConceptStat>()
  for (const [tagId, v] of acc) {
    result.set(tagId, { tagId, ...v })
  }
  return result
}

/** タグの正答率(0〜1)。挑戦記録が無ければ`null`。 */
export function moveAccuracy(stat: ConceptStat): number | null {
  return stat.attempts > 0 ? stat.correct / stat.attempts : null
}

/** タグの理由正答率(0〜1)。挑戦記録が無ければ`null`。 */
export function reasonAccuracy(stat: ConceptStat): number | null {
  return stat.attempts > 0 ? stat.reasonCorrect / stat.attempts : null
}

/** 重み付き抽選での最小重み(`tsume/stats.ts`の`MIN_WEIGHT`と同じ安全弁)。 */
const MIN_WEIGHT = 0.1

/**
 * T036要件6「出題バイアスへの反映」: `tagIds`(1つの出題候補が持つタグ集合)から
 * 出題重みを求める。`tsume/stats.ts`の`puzzleWeight`(T027)と同じ考え方
 * (`2 - 平均正答率`、平均は手の正誤・理由正誤の単純平均)を踏襲した簡易ロジック
 * (タスク仕様「T027のpickWeightedPuzzleのパターンを参考にしてよい」)。
 * `tagIds`が空、またはどのタグも統計に存在しない場合は基準重み`1`を返す
 * (未挑戦のタグは正答率100%扱い、`tsume/stats.ts`と同じ規約)。
 */
export function conceptWeight(tagIds: readonly string[], stats: ReadonlyMap<string, ConceptStat>): number {
  if (tagIds.length === 0) return 1
  const accuracies = tagIds.map((tagId) => {
    const stat = stats.get(tagId)
    if (!stat || stat.attempts === 0) return 1
    const move = moveAccuracy(stat) ?? 1
    const reason = reasonAccuracy(stat) ?? 1
    return (move + reason) / 2
  })
  const avgAccuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length
  return Math.max(MIN_WEIGHT, 2 - avgAccuracy)
}

/** ダッシュボード表示用に、`stats`を理由正答率の低い順(弱点が強い順)にソートした配列にする。 */
export function sortByWeakness(stats: ReadonlyMap<string, ConceptStat>): ConceptStat[] {
  return [...stats.values()].sort((a, b) => {
    const ra = reasonAccuracy(a) ?? 1
    const rb = reasonAccuracy(b) ?? 1
    if (ra !== rb) return ra - rb
    return b.attempts - a.attempts
  })
}

/**
 * 最低挑戦回数(これ未満のタグは、たまたま1回外しただけの可能性が高く「弱点」と
 * 強調するにはサンプルが少なすぎるため、サマリー文言の対象から除外する)。
 */
export const MIN_ATTEMPTS_FOR_SUMMARY = 2

/**
 * ダッシュボードのサマリー文言(要件5、設計書§8の「あなたの負けの42%は壁絡み。
 * 開放度の理由正答率55%」のような目立つ弱点強調文)用に、最も弱い1タグを選ぶ。
 * `MIN_ATTEMPTS_FOR_SUMMARY`回未満しか挑戦していないタグは対象外。該当タグが
 * 無ければ`null`。
 */
export function pickWeakestConcept(stats: ReadonlyMap<string, ConceptStat>): ConceptStat | null {
  const candidates = [...stats.values()].filter((s) => s.attempts >= MIN_ATTEMPTS_FOR_SUMMARY)
  if (candidates.length === 0) return null
  return sortByWeakness(new Map(candidates.map((s) => [s.tagId, s])))[0] ?? null
}
