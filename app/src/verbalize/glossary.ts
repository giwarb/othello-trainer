/**
 * T036「用語集」(`othello-trainer-design-verbalization.md` §7)のデータ定義。
 *
 * # 項目数についてのスコープ縮小(タスク仕様「本タスクでのスコープ縮小」1参照)
 *
 * 設計書§7は「開放度」「偶数理論」など12テーマの概念レッスンを例示するのみで、
 * 具体的なテーマ名の網羅列挙は無い。本タスクでは、T032の`MOTIF_CATALOG`(15種)+
 * T035の評価内訳分解ベースタグ(`reasonTags.ts`の`ATTRIBUTION_TAG_ID`、3種)の
 * 計18種をそのまま用語集の項目として使う(実装者判断、タスク仕様で明示的に許容)。
 * 二重管理を避けるため、タグの一覧・ラベル自体は`MOTIF_CATALOG`/`ATTRIBUTION_TAG_ID`
 * から導出し、本ファイルは各項目の説明文(定義文)のみを追加する。
 *
 * 各定義文は、`analysis/motifs.ts`(各`detect*`関数のJSDoc、検出条件そのもの)・
 * `verbalize/reasonTags.ts`(`ATTRIBUTION_REASON_TAGS`の説明文)・
 * `analysis/attribution.ts`(`TERM_LABELS`)に既に記載されている検証済みの定義を
 * 平易な文章に要約したものであり、新規の判定基準を作り出してはいない。
 *
 * # 例局面・反例局面についてのスコープ縮小
 *
 * 設計書§7が要求する「最小例局面2つ+反例局面1つ」は、本ファイル(静的データ)には
 * 持たせない。18項目 x 3局面 = 54局面を人手で構築すると、実際に各`detect*`関数が
 * trueを返すかを静的に検証する手段が無く(検出には`engine/src/explain.rs`が返す
 * `FeatureSet`が必要で、これはWASMエンジンでしか計算できない)、誤った例を用語集に
 * 載せてしまうリスクが高い。そこで例局面・反例局面は`glossaryExamples.ts`が
 * 実行時に出題プール(`midgame/pool.ts`)から実際の検出関数(`detectMotifs`/
 * `buildAttribution`)を使って動的に検索する(タスク仕様が明示する「既存の出題
 * プール等から該当する特徴を持つ局面を検索して採用する」の方式を採用)。
 */

import { MOTIF_CATALOG, type MotifDefinition } from '../analysis/motifs.ts'
import type { AttributionTerm } from '../analysis/types.ts'
import { ATTRIBUTION_TAG_ID } from './reasonTags.ts'

/** 用語集項目の分類(バッジ色分け・フィルタ表示用)。 */
export type GlossaryCategory = 'motif-good' | 'motif-bad' | 'motif-trap' | 'attribution'

export interface GlossaryEntry {
  /** タグID。モチーフ項目は`MotifDefinition.key`、評価内訳項目は`ATTRIBUTION_TAG_ID`の値と一致する。 */
  readonly key: string
  readonly label: string
  readonly category: GlossaryCategory
  /** 定義文(2〜3文程度)。 */
  readonly definition: string
  /** 例局面検索(`glossaryExamples.ts`)の方式切り替え用。 */
  readonly kind: 'motif' | 'attribution'
  /** `kind === 'attribution'` の場合の`AttributionTerm.key`。 */
  readonly attributionKey?: AttributionTerm['key']
}

const CATEGORY_BY_MOTIF_KIND: Record<MotifDefinition['kind'], GlossaryCategory> = {
  good: 'motif-good',
  bad: 'motif-bad',
  trap: 'motif-trap',
}

/** モチーフ15種の定義文。`analysis/motifs.ts`の各`detect*`関数のJSDocを要約。 */
const MOTIF_DEFINITIONS: Record<string, string> = {
  nakawari:
    '開放度(この手を打ったあと、相手に新しく開放されるマスの数)が小さい手です。相手の選択肢をむやみに広げず、局面を落ち着かせる基本手筋とされます。',
  block:
    '着手可能数差(自分の合法手数と相手の合法手数の差)を大きく広げる手です。相手の選択肢を大きく制限し、主導権を握りやすくします。',
  tanezukuriCreate:
    '着手後、相手の石のうち自分が今後の辺の着手で挟み返せるもの(種石)を新たに作る手です。将来の攻め材料を仕込む狙いがあります。',
  henNoSencyaku:
    'まだどちらの石も置かれていない辺に、最初に着手する手です。辺への先着は、その後の辺の形や隅の攻防で有利に働きやすいとされます。',
  hipparu:
    'この着手によって、相手が持っていたX打ち/C打ち(隅がまだ空いている状態での危険な攻め筋)の選択肢を消してしまう手です。相手の好手を未然に封じます。',
  tooshi:
    '対角線(主対角線・反対角線)の一方で、相手の石を1つも許さないまま自分の石を伸ばしている状態です。そのラインを一方的に支配できていることを示します。',
  zengaeshi:
    '開放度が大きすぎる手、つまり相手に多くの新しい着手先を与えてしまう手です。中割りの対極にあたり、一般に避けるべきとされます。',
  kabezukuri:
    '着手によって自分のフロンティア石(空きマスに接し、まだ確定していない石)が大きく増える手です。将来相手に挟み返されやすい弱い石を増やしてしまいます。',
  tezon:
    '着手可能数差を自分から大きく悪化させてしまう手です。「ブロック」の対極にあたり、自分自身の選択肢を狭めてしまいます。',
  xUchi:
    '隅がまだ空いている状態で、その隅の斜め隣のマス(Xマス)に打つ手です。多くの場合、根拠なく相手にその隅を明け渡してしまう危険な手とされます。',
  cUchi:
    '隅がまだ空いている状態で、その隅の直交隣のマス(Cマス)に打つ手です。X打ちと同様、隅を失う危険を伴う手とされます。',
  tanezukuriSupply:
    '着手後、自分の石が相手の今後の辺の着手によって挟み返される「種石」になってしまう手です。自分から相手に攻め材料を与えてしまいます。',
  gusuuHouki:
    '盤面が複数の空き領域に分かれている局面で、最大かつ偶数マスの領域に不必要に踏み込んでしまう手です。終盤の手番構造(偶数理論)上、不利になりやすいとされます。',
  jimetsu:
    '着手によって自分自身の着手可能数を大きく減らしてしまう手です。相手ではなく自分の選択肢を潰してしまいます。',
  stoner:
    '辺の形が「ウィング」(片隅が空きで、その手前が埋まっている形)になっており、かつ空いている隅に対応するX打ちマスが自分の種石になっている局面パターンです。相手を誘い込む罠筋の一種とされます。',
}

/** 評価内訳分解ベース3種の定義文。`reasonTags.ts`の`ATTRIBUTION_REASON_TAGS`の説明を敷衍したもの。 */
const ATTRIBUTION_DEFINITIONS: Record<AttributionTerm['key'], string> = {
  mobility:
    '自分と相手の着手可能数の差が、2手の評価差に最も大きく寄与している状態です。着手可能数(選択肢の広さ)を確保・制限することを重視した手であることを示します。',
  corner:
    '隅の確保や、危険な手(X打ち/C打ち)の有無が、2手の評価差に最も大きく寄与している状態です。隅に関する損得を重視した手であることを示します。',
  stable:
    'ひっくり返らない石(確定石)の増減が、2手の評価差に最も大きく寄与している状態です。安定した地を作る、または減らさないことを重視した手であることを示します。',
}

const ATTRIBUTION_LABELS: Record<AttributionTerm['key'], string> = {
  mobility: 'モビリティ(着手可能数)',
  corner: '隅',
  stable: '安定石(確定石)',
}

const MOTIF_ENTRIES: readonly GlossaryEntry[] = MOTIF_CATALOG.map((motif) => ({
  key: motif.key,
  label: motif.label,
  category: CATEGORY_BY_MOTIF_KIND[motif.kind],
  definition: MOTIF_DEFINITIONS[motif.key] ?? motif.label,
  kind: 'motif',
}))

const ATTRIBUTION_ENTRIES: readonly GlossaryEntry[] = (
  Object.keys(ATTRIBUTION_TAG_ID) as AttributionTerm['key'][]
).map((attrKey) => ({
  key: ATTRIBUTION_TAG_ID[attrKey],
  label: ATTRIBUTION_LABELS[attrKey],
  category: 'attribution',
  definition: ATTRIBUTION_DEFINITIONS[attrKey],
  kind: 'attribution',
  attributionKey: attrKey,
}))

/** 用語集の全項目(要件1: モチーフ15種+評価内訳3種の計18項目)。 */
export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = [...MOTIF_ENTRIES, ...ATTRIBUTION_ENTRIES]

const GLOSSARY_ENTRY_BY_KEY: ReadonlyMap<string, GlossaryEntry> = new Map(
  GLOSSARY_ENTRIES.map((entry) => [entry.key, entry]),
)

/** タグIDから用語集項目を引く(見つからなければ`undefined`)。 */
export function findGlossaryEntry(key: string): GlossaryEntry | undefined {
  return GLOSSARY_ENTRY_BY_KEY.get(key)
}

export const GLOSSARY_CATEGORY_LABEL: Record<GlossaryCategory, string> = {
  'motif-good': '良い手筋',
  'motif-bad': '悪い手筋',
  'motif-trap': '罠筋',
  attribution: '評価内訳の軸',
}
