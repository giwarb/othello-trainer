/**
 * T035「言語化トレーニングモード」の理由タグ語彙(設計書§6.1手順3)。
 *
 * タスク仕様「本タスクでのスコープ縮小」: 「理由タグ」の語彙は、T032のモチーフタグ
 * (`analysis/motifs.ts`、15種実装済み)+ T031の特徴量ベースの簡易語彙(モビリティ/
 * 隅/安定石の3項)を組み合わせて使う。設計書の「特徴語彙」全体を新規に定義し直す
 * 必要はない、というスコープに従う。
 *
 * モチーフの一覧は`analysis/motifs.ts`の`MOTIF_CATALOG`(本タスクのために追加した
 * 一覧エクスポート)をそのまま再利用し、タグの定義を二重管理しない。
 */

import { MOTIF_CATALOG, type MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionTerm } from '../analysis/types.ts'

/** 1個の理由タグ。 */
export interface ReasonTag {
  readonly id: string
  readonly label: string
  /** 「概念レッスンへ誘導」(要件5、T036の用語集が無い現時点の代替)で表示する簡易説明。 */
  readonly description: string
}

/**
 * T031ベースの簡易語彙(3項)のタグID。`AttributionTerm.key`(`attribution.ts`)と
 * 1:1対応させ、`judgeVerbalization.ts`が寄与分解の結果からこのIDを直接引けるようにする。
 */
export const ATTRIBUTION_TAG_ID: Record<AttributionTerm['key'], string> = {
  mobility: 'attr-mobility',
  corner: 'attr-corner',
  stable: 'attr-stable',
}

export const ATTRIBUTION_REASON_TAGS: readonly ReasonTag[] = [
  {
    id: ATTRIBUTION_TAG_ID.mobility,
    label: 'モビリティを重視した',
    description: '着手可能数(自分の選択肢の広さ・相手の選択肢の狭さ)を重視した手です。',
  },
  {
    id: ATTRIBUTION_TAG_ID.corner,
    label: '隅を意識した',
    description: '隅の確保、または危険な手(X打ち/C打ち)の回避など、隅に関する損得を意識した手です。',
  },
  {
    id: ATTRIBUTION_TAG_ID.stable,
    label: '安定石を意識した',
    description: 'ひっくり返らない石(確定石)を増やす、または減らさないことを意識した手です。',
  },
]

const MOTIF_KIND_HINT: Record<MotifDefinition['kind'], string> = {
  good: '一般に良いとされる手筋',
  bad: '一般に悪いとされる手筋',
  trap: '相手を誘い込む罠筋',
}

/** T032のモチーフをそのままタグ化したもの(`id`は`MotifDefinition.key`と一致)。 */
export const MOTIF_REASON_TAGS: readonly ReasonTag[] = MOTIF_CATALOG.map((motif) => ({
  id: motif.key,
  label: motif.label,
  description: `「${motif.label}」(${MOTIF_KIND_HINT[motif.kind]})に該当すると考えた場合に選んでください。`,
}))

/** 選択可能な全理由タグ(要件3)。 */
export const ALL_REASON_TAGS: readonly ReasonTag[] = [...ATTRIBUTION_REASON_TAGS, ...MOTIF_REASON_TAGS]

const REASON_TAG_BY_ID: ReadonlyMap<string, ReasonTag> = new Map(ALL_REASON_TAGS.map((tag) => [tag.id, tag]))

/** タグIDから定義を引く(見つからなければ`undefined`)。 */
export function findReasonTag(id: string): ReasonTag | undefined {
  return REASON_TAG_BY_ID.get(id)
}

/** タグ選択UIで同時に選べる上限個数(要件3: 1〜3個)。 */
export const MAX_CHOSEN_TAGS = 3
