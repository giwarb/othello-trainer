/**
 * T032: 言語化支援「モチーフ検出タグ」(`othello-trainer-design-verbalization.md` §4)。
 *
 * T031の特徴量層(`engine/src/explain.rs`の`featureSet`コマンド、`FeatureSet`型
 * = `FeatureSetJson`)の出力と、着手前後の局面から、人間になじみのある概念タグ
 * (中割り・全返し・壁作り等)を検出する純粋関数群。エンジン呼び出しは行わない
 * (`whyBad.ts`・`attribution.ts`と同じ設計方針)。
 *
 * # スコープについての重要な注記
 *
 * 設計書§4のモチーフリストは以下20種(良い手9・悪い手8・罠3)だが、本モジュールは
 * このうち15種のみを実装する。実装しなかった5種とその理由:
 *
 * - **爆弾・隅絡みの一方通行**(罠系): 設計書内に検出条件の記載が一切なく
 *   (名称のみ)、実装すると根拠のないロジックを捏造することになる。このプロジェクト
 *   では過去(T016、定石データ)に出典の無いデータを捏造してしまい2回のやり直しに
 *   なった経緯があり、同じ過ちを避けるため実装しない(タスク仕様で明示的にスコープ外
 *   と指定されている)。
 * - **手止まり確保**(良い手): 「相手を強制的に悪手へ追い込む」という概念は、
 *   1手先の特徴量だけでは判定できず、数手先までの強制手順の読みが必要になる。
 *   機械的な近似定義が思いつかず、タスク仕様の「無理に定義できないものは省略して
 *   よい」を適用し省略する。
 * - **余裕手の温存**(良い手): 「余裕手」自体が設計書§1.1で「浅い評価でロス<0.5の
 *   手を数える」と定義されており、`engine/src/explain.rs`の冒頭コメントの通り
 *   エンジンへの浅い探索呼び出し(`requestAnalyzeAll`相当)が必要である。本モジュールは
 *   他のモチーフ検出関数と同じ「エンジン呼び出しなしの純粋関数」という設計方針を
 *   統一して守るため、この1つのためだけに非同期・エンジン呼び出し版の別経路を
 *   設けることはせず、今回は省略する(将来別タスクで非同期版として追加可能)。
 * - **犠牲打**(良い手): 「一時的な石損と引き換えに偶数や隅を確保する」という
 *   概念は、この1手だけでなく後続の獲得(偶数支配・隅確保)が実際に実現するかまで
 *   数手先を評価しないと判定できない。1手先の特徴量差分だけからの近似では
 *   「石を losses した手」と区別がつかず、誤検出が多くなると判断し省略する。
 *
 * 上記5種はいずれも「明確な機械的定義が設計書に無いため実装者判断で近似してよい、
 * 無理なら省略してよい」とタスク仕様が明示的に許容している範囲内の判断である
 * (詳細は`tasks/T032-motif-detection-overlay.md`の作業ログを参照)。
 *
 * 実装した15種のうち、以下は「設計書に厳密な定義が無い概念」を実装者判断で
 * 近似したものである(各関数のコメントに個別の判断根拠を記載):
 * ブロック・引っ張り・辺の先着・種石作り・壁作り・全返し・手損・偶数放棄・自滅・
 * ストナー。「中割り」「X打ち」「C打ち」「種石供給」「通し」は既存の特徴量
 * (`isUchiwari`・`whyBad.ts`のcornerRisk・`seedStones`・`lines`)をほぼそのまま
 * 転用した、閾値以外の判断余地が小さいものである。
 */

import {
  applyMove,
  cellAt,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board,
  type Side,
} from '../game/othello.ts'
import type { EdgeShapeJson } from '../engine/types.ts'
import { analyzeWhyBad } from './whyBad.ts'
import type { FeatureSet } from './types.ts'

// ---------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------

export type MotifKind = 'good' | 'bad' | 'trap'

export interface MotifDefinition {
  readonly key: string
  readonly label: string
  readonly kind: MotifKind
}

/**
 * モチーフ検出関数群への統一入力。`beforeBoard`は着手前局面、`square`は
 * `legalMoves(beforeBoard, side)`に含まれる合法手であることを前提とする
 * (`whyBad.ts`の`analyzeWhyBad`と同じ前提)。`features`はT031の
 * `EngineClient.requestFeatureSet`が返す`FeatureSet`(= `FeatureSetJson`)。
 */
export interface MotifContext {
  readonly beforeBoard: Board
  readonly side: Side
  readonly square: number
  readonly features: FeatureSet
}

// ---------------------------------------------------------------------
// 内部ヘルパー(盤面から特徴量に無いマス単位の情報を導出する)
// ---------------------------------------------------------------------

type EdgeName = EdgeShapeJson['edge']

/** 4辺それぞれの8マス(`engine/src/eval.rs`のTOP_EDGE等と同じ順序・対応)。 */
const EDGES: Record<EdgeName, readonly number[]> = {
  top: [0, 1, 2, 3, 4, 5, 6, 7],
  bottom: [56, 57, 58, 59, 60, 61, 62, 63],
  left: [0, 8, 16, 24, 32, 40, 48, 56],
  right: [7, 15, 23, 31, 39, 47, 55, 63],
}

/** 各辺の両端(隅)のマス番号。`edge_shapes`の`corner0`/`corner7`相当の判定に使う。 */
const EDGE_CORNERS: Record<EdgeName, readonly [number, number]> = {
  top: [0, 7],
  bottom: [56, 63],
  left: [0, 56],
  right: [7, 63],
}

/** 隅 -> 対応するX打ちマス(隅の斜め隣)。`engine/src/explain.rs`の`X_SQUARE_TO_CORNER`の逆写像。 */
const CORNER_TO_X_SQUARE: ReadonlyMap<number, number> = new Map([
  [0, 9], // a1 -> b2
  [7, 14], // h1 -> g2
  [56, 49], // a8 -> b7
  [63, 54], // h8 -> g7
])

/**
 * X打ちマス(隅の斜め隣)-> 対応する隅マス番号。`whyBad.ts`・`engine/src/explain.rs`と
 * 同じ対応表(それぞれのファイルで意図的に個別に定義されている既存の慣習に合わせ、
 * 本ファイルでも小さな対応表を独自に持つ)。
 */
const X_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [9, 0],
  [14, 7],
  [49, 56],
  [54, 63],
])

/** C打ちマス(隅の直交隣、辺上)-> 対応する隅マス番号。上記と同じ理由で個別に定義する。 */
const C_SQUARE_TO_CORNER: ReadonlyMap<number, number> = new Map([
  [1, 0],
  [8, 0],
  [6, 7],
  [15, 7],
  [57, 56],
  [48, 56],
  [62, 63],
  [55, 63],
])

function isEdgeSquare(square: number): boolean {
  const file = square % 8
  const rank = Math.floor(square / 8)
  return file === 0 || file === 7 || rank === 0 || rank === 7
}

/** マス`square`の8近傍(盤内のみ)を返す。フロンティア判定に使う。 */
function neighbors8(square: number): number[] {
  const file = square % 8
  const rank = Math.floor(square / 8)
  const result: number[] = []
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue
      const f = file + df
      const r = rank + dr
      if (f >= 0 && f <= 7 && r >= 0 && r <= 7) result.push(r * 8 + f)
    }
  }
  return result
}

/** マス`square`の直交4近傍(盤内のみ)を返す。地域偶数(パリティ領域)判定に使う。 */
function orthogonalNeighbors(square: number): number[] {
  const file = square % 8
  const rank = Math.floor(square / 8)
  const result: number[] = []
  if (rank > 0) result.push(square - 8)
  if (rank < 7) result.push(square + 8)
  if (file > 0) result.push(square - 1)
  if (file < 7) result.push(square + 1)
  return result
}

/** `side`の石のうち、空きマスに隣接する(フロンティア)石のマス番号一覧を返す。 */
export function frontierSquares(board: Board, side: Side): number[] {
  const result: number[] = []
  for (let sq = 0; sq < 64; sq++) {
    if (cellAt(board, sq) !== side) continue
    if (neighbors8(sq).some((n) => cellAt(board, n) === null)) result.push(sq)
  }
  return result
}

interface ParityRegionLocal {
  readonly squares: readonly number[]
  readonly size: number
  readonly parity: 'odd' | 'even'
}

/**
 * 空きマスを直交4方向の連結成分に分解する(`engine/src/explain.rs`の
 * `compute_parity_regions`と同じアルゴリズムのTS版。地域偶数の判定
 * (`detectGusuuHouki`)は着手前局面に対して行う必要があり、`FeatureSet`の
 * `parityRegions`は着手後局面のものなので使えないため、TS側で独自に計算する)。
 */
function computeParityRegionsLocal(board: Board): ParityRegionLocal[] {
  const visited = new Set<number>()
  const regions: ParityRegionLocal[] = []

  for (let start = 0; start < 64; start++) {
    if (cellAt(board, start) !== null || visited.has(start)) continue
    const stack = [start]
    visited.add(start)
    const squares: number[] = []
    while (stack.length > 0) {
      const sq = stack.pop()!
      squares.push(sq)
      for (const n of orthogonalNeighbors(sq)) {
        if (cellAt(board, n) === null && !visited.has(n)) {
          visited.add(n)
          stack.push(n)
        }
      }
    }
    squares.sort((a, b) => a - b)
    regions.push({ squares, size: squares.length, parity: squares.length % 2 === 0 ? 'even' : 'odd' })
  }

  return regions
}

/**
 * `victimSide`の石のうち、`attackerSide`が現在打てる辺上の合法手いずれかに
 * よって挟まれて返される石のマス番号集合を返す。`engine/src/explain.rs`の
 * `compute_seed_stones(after, side, opp)`と同じアルゴリズム
 * (victimSide=side, attackerSide=opp に対応)。
 *
 * `FeatureSet.seedStones`はRust側で「自分(mover)の石が相手の辺打ちで
 * 危険になる」方向(victim=mover, attacker=opp)しか計算していないため、
 * 「種石作り」(victim=opp, attacker=mover、逆方向)の判定にはこの関数で
 * TS側から改めて同じアルゴリズムを呼ぶ必要がある。
 */
function computeVulnerableSeeds(board: Board, victimSide: Side, attackerSide: Side): Set<number> {
  const attackerEdgeMoves = legalMoves(board, attackerSide).filter(isEdgeSquare)
  const seeds = new Set<number>()
  for (const mv of attackerEdgeMoves) {
    const hypothetical = applyMove(board, attackerSide, mv)
    for (let sq = 0; sq < 64; sq++) {
      if (cellAt(board, sq) === victimSide && cellAt(hypothetical, sq) !== victimSide) {
        seeds.add(sq)
      }
    }
  }
  return seeds
}

// ---------------------------------------------------------------------
// モチーフ検出関数(良い手系)
// ---------------------------------------------------------------------

/** 中割り: 開放度(特徴量3)が小さい(`FeatureSet.isUchiwari`をそのまま使う)。 */
export function detectNakawari(ctx: MotifContext): boolean {
  return ctx.features.isUchiwari
}

/**
 * ブロック: 着手可能数差(特徴量1、`mobilityDiff = 着手前の自分の合法手数 -
 * 着手後の相手の合法手数`)が大きく、相手の選択肢を大きく削っている。
 * 閾値4は「手損」(下記)の閾値-4と対称に選んだ実装者判断の値
 * (根拠: 初期局面付近の合法手数はおおむね4前後であり、その規模の差が
 * 生じていれば十分「相手を制限した」と言えると判断した)。
 */
const MOBILITY_BLOCK_THRESHOLD = 4
export function detectBlock(ctx: MotifContext): boolean {
  return ctx.features.mobilityDiff >= MOBILITY_BLOCK_THRESHOLD
}

/**
 * 種石作り: 着手後の局面で、相手の石のうち自分が今後打てる辺上の手によって
 * 挟み返せる(=将来の攻め材料になる)ものが存在する。`FeatureSet.seedStones`
 * (自分が相手に種石を供給する方向)の逆方向を`computeVulnerableSeeds`で計算する。
 */
export function detectTanezukuriCreate(ctx: MotifContext): boolean {
  const after = applyMove(ctx.beforeBoard, ctx.side, ctx.square)
  const opp = opposite(ctx.side)
  return computeVulnerableSeeds(after, opp, ctx.side).size > 0
}

/**
 * 辺の先着: 着手先が辺(4辺いずれか)のマスで、着手前はその辺の8マス全てが
 * 空きだった(=この着手がその辺への最初の着手)。
 */
export function detectHenNoSencyaku(ctx: MotifContext): boolean {
  const edgeName = (Object.keys(EDGES) as EdgeName[]).find((name) => EDGES[name].includes(ctx.square))
  if (!edgeName) return false
  return EDGES[edgeName].every((sq) => cellAt(ctx.beforeBoard, sq) === null)
}

/**
 * 引っ張り(相手の好手を消す): この着手によって、相手が着手前に持っていた
 * X打ち/C打ちの合法手(対応する隅がまだ空いている、=相手にとって危険を
 * 冒してでも打つ価値がありうる手)が着手後に失われた。
 *
 * 「相手の好手」の一般的な定義は困難なため、「相手にとってのX打ち/C打ち
 * (隅がまだ空いている場合の危険な攻め筋)」という具体的で機械的に判定できる
 * 対象に絞った実装者判断の近似。
 */
export function detectHipparu(ctx: MotifContext): boolean {
  const opp = opposite(ctx.side)
  const beforeOppMoves = legalMoves(ctx.beforeBoard, opp)
  const after = applyMove(ctx.beforeBoard, ctx.side, ctx.square)
  const afterOppMoves = new Set(legalMoves(after, opp))
  const removed = beforeOppMoves.filter((sq) => !afterOppMoves.has(sq))
  return removed.some((sq) => {
    const corner = X_SQUARE_TO_CORNER.get(sq) ?? C_SQUARE_TO_CORNER.get(sq)
    return corner !== undefined && cellAt(ctx.beforeBoard, corner) === null
  })
}

/**
 * 通し: 主対角線/反対角線(特徴量12のライン)のいずれかで、相手石が0個かつ
 * 自分の石が閾値(4、8マス中の過半数)以上。ライン全体を完全制圧していなくても
 * 「相手に一切邪魔されず優勢に伸ばせている」状態を「通し」とみなす実装者判断。
 */
const TOOSHI_MOVER_THRESHOLD = 4
export function detectTooshi(ctx: MotifContext): boolean {
  return ctx.features.lines.some((line) => line.opponent === 0 && line.mover >= TOOSHI_MOVER_THRESHOLD)
}

// ---------------------------------------------------------------------
// モチーフ検出関数(悪い手系)
// ---------------------------------------------------------------------

/**
 * 全返し(開放度過大): 開放度(特徴量3)が大きい。中割り(`isUchiwari`、
 * openness<=2)の対極として、その2倍を超える水準(6以上)を「過大」とみなす
 * 実装者判断の閾値。
 */
const ZENGAESHI_OPENNESS_THRESHOLD = 6
export function detectZengaeshi(ctx: MotifContext): boolean {
  return ctx.features.openness >= ZENGAESHI_OPENNESS_THRESHOLD
}

/**
 * 壁作り: 着手によって自分のフロンティア石数(空きマスに接する自石数)が
 * 明確に増加した。着手そのものが盤の開いた領域の近くで行われることが多く
 * 1個の増加は不可避なことが多いため、閾値を2以上(着手した石自体以外にも
 * 既存の自石が新たにフロンティア化した場合)とした実装者判断。
 */
const KABEZUKURI_FRONTIER_DELTA_THRESHOLD = 2
export function detectKabezukuri(ctx: MotifContext): boolean {
  const after = applyMove(ctx.beforeBoard, ctx.side, ctx.square)
  const delta = frontierSquares(after, ctx.side).length - frontierSquares(ctx.beforeBoard, ctx.side).length
  return delta >= KABEZUKURI_FRONTIER_DELTA_THRESHOLD
}

/**
 * 手損: 着手可能数差(特徴量1)が大きく悪化している(`detectBlock`の対極、
 * 閾値-4は対称に選んだ値)。
 */
const MOBILITY_TEZON_THRESHOLD = -4
export function detectTezon(ctx: MotifContext): boolean {
  return ctx.features.mobilityDiff <= MOBILITY_TEZON_THRESHOLD
}

/** X打ち(無根拠): `whyBad.ts`(T030)の検出ロジックをそのまま再利用する。 */
export function detectXUchi(ctx: MotifContext): boolean {
  const whyBad = analyzeWhyBad(ctx.beforeBoard, ctx.side, ctx.square)
  return whyBad.cornerRisk?.kind === 'x'
}

/** C打ち(無根拠): `whyBad.ts`(T030)の検出ロジックをそのまま再利用する。 */
export function detectCUchi(ctx: MotifContext): boolean {
  const whyBad = analyzeWhyBad(ctx.beforeBoard, ctx.side, ctx.square)
  return whyBad.cornerRisk?.kind === 'c'
}

/** 種石供給: `FeatureSet.seedStones`(特徴量11)が1個以上ある。 */
export function detectTanezukuriSupply(ctx: MotifContext): boolean {
  return ctx.features.seedStones.length >= 1
}

/**
 * 偶数放棄: 着手前局面で盤が複数の空き領域に分かれており(regions.length>=2、
 * まだ領域分割されていない序盤は対象外とする)、着手先が「最大サイズかつ偶数」
 * の領域に属し、かつ他に選択肢があった(強制手ではない)。
 *
 * 偶数理論の厳密な適用(残り空きマス数全体のパリティ・手番の巡り等)は本タスクの
 * スコープを超える高度な終盤理論のため、「最大の偶数領域に不必要に踏み込む」
 * という単純化した近似とした(実装者判断)。閾値8は「戦略的に意味のある規模の
 * 領域」の目安として選んだ。
 */
const GUSUU_HOUKI_MIN_REGION_SIZE = 8
export function detectGusuuHouki(ctx: MotifContext): boolean {
  const regions = computeParityRegionsLocal(ctx.beforeBoard)
  if (regions.length < 2) return false
  const maxSize = Math.max(...regions.map((r) => r.size))
  const region = regions.find((r) => r.squares.includes(ctx.square))
  if (!region) return false
  if (region.size !== maxSize) return false
  if (region.size % 2 !== 0) return false
  if (region.size < GUSUU_HOUKI_MIN_REGION_SIZE) return false
  return legalMoves(ctx.beforeBoard, ctx.side).length > 1
}

/**
 * 自滅(自分の手数を自分で消す): 着手によって消える自分の合法手
 * (特徴量5、`lostOwnMoves`)が2個以上。1個の消失は通常の着手でも
 * ありふれているため、閾値を2以上とした実装者判断。
 */
const JIMETSU_LOST_MOVES_THRESHOLD = 2
export function detectJimetsu(ctx: MotifContext): boolean {
  return ctx.features.lostOwnMoves.length >= JIMETSU_LOST_MOVES_THRESHOLD
}

// ---------------------------------------------------------------------
// モチーフ検出関数(罠系)
// ---------------------------------------------------------------------

/**
 * ストナー: 設計書の成立条件ヒント「辺の形+X筋の種石を厳密判定」を文字通り
 * 機械的に組み合わせた実装。着手後の局面で、ある辺の形が「ウィング」
 * (`FeatureSet.edgeShapes`、片隅が空きでC相当が埋まっている形)であり、
 * かつその空いている隅に対応するX打ちマス(斜め隣)が自分の種石
 * (`FeatureSet.seedStones`)になっている場合に検出する。
 *
 * 【重要な限定】オセロ理論における伝統的な「ストナーの罠」の正確な成立条件を
 * 検証済みの資料から確認できていないため、本実装はそれを再現すると主張する
 * ものではない。設計書が示した「辺の形+X筋の種石」という2つの既存特徴量の
 * 組み合わせヒントを、機械的かつ保守的に(既に計算済みの`edgeShapes`と
 * `seedStones`のみを使い、新たな当て推量を加えずに)実装したものである
 * (「爆弾」「隅絡みの一方通行」のように手がかりが皆無なものとは異なり、
 * この2特徴量の組み合わせという具体的なヒントがあるため実装を試みた)。
 */
export function detectStoner(ctx: MotifContext): boolean {
  const after = applyMove(ctx.beforeBoard, ctx.side, ctx.square)
  for (const edgeShape of ctx.features.edgeShapes) {
    if (edgeShape.shape !== 'wing') continue
    const [c0, c7] = EDGE_CORNERS[edgeShape.edge]
    const openCorner = cellAt(after, c0) === null ? c0 : cellAt(after, c7) === null ? c7 : null
    if (openCorner === null) continue
    const xSquare = CORNER_TO_X_SQUARE.get(openCorner)
    if (xSquare === undefined) continue
    if (ctx.features.seedStones.includes(squareToNotation(xSquare))) return true
  }
  return false
}

// ---------------------------------------------------------------------
// レジストリ + 統合エントリポイント
// ---------------------------------------------------------------------

interface MotifEntry extends MotifDefinition {
  readonly detect: (ctx: MotifContext) => boolean
}

const MOTIF_ENTRIES: readonly MotifEntry[] = [
  { key: 'nakawari', label: '中割り', kind: 'good', detect: detectNakawari },
  { key: 'block', label: 'ブロック', kind: 'good', detect: detectBlock },
  { key: 'tanezukuriCreate', label: '種石作り', kind: 'good', detect: detectTanezukuriCreate },
  { key: 'henNoSencyaku', label: '辺の先着', kind: 'good', detect: detectHenNoSencyaku },
  { key: 'hipparu', label: '引っ張り', kind: 'good', detect: detectHipparu },
  { key: 'tooshi', label: '通し', kind: 'good', detect: detectTooshi },
  { key: 'zengaeshi', label: '全返し', kind: 'bad', detect: detectZengaeshi },
  { key: 'kabezukuri', label: '壁作り', kind: 'bad', detect: detectKabezukuri },
  { key: 'tezon', label: '手損', kind: 'bad', detect: detectTezon },
  { key: 'xUchi', label: 'X打ち(無根拠)', kind: 'bad', detect: detectXUchi },
  { key: 'cUchi', label: 'C打ち(無根拠)', kind: 'bad', detect: detectCUchi },
  { key: 'tanezukuriSupply', label: '種石供給', kind: 'bad', detect: detectTanezukuriSupply },
  { key: 'gusuuHouki', label: '偶数放棄', kind: 'bad', detect: detectGusuuHouki },
  { key: 'jimetsu', label: '自滅', kind: 'bad', detect: detectJimetsu },
  { key: 'stoner', label: 'ストナー', kind: 'trap', detect: detectStoner },
]

/** `ctx`に該当する全てのモチーフタグを検出する(要件1)。 */
export function detectMotifs(ctx: MotifContext): MotifDefinition[] {
  return MOTIF_ENTRIES.filter((entry) => entry.detect(ctx)).map(({ key, label, kind }) => ({ key, label, kind }))
}

// ---------------------------------------------------------------------
// 盤面オーバーレイ用: 特徴量由来のマス集合(要件3)
// ---------------------------------------------------------------------

export interface BoardHighlights {
  /** フロンティア石(特徴量4): 空きマスに接する石(自分・相手とも)。 */
  readonly frontier: readonly number[]
  /** 確定石(特徴量6、`whyBad.ts`の`computeStableSquares`と同じ簡易判定): 自分の確定石。 */
  readonly stable: readonly number[]
  /** 種石(特徴量11): `FeatureSet.seedStones`をマス番号に変換したもの。 */
  readonly seed: readonly number[]
  /** X/C打ちで危険なマス(特徴量8): 対応する隅がまだ空いているX/C打ちマス全て。 */
  readonly dangerousCorners: readonly number[]
}

/** X/C打ちマス(隅がまだ空いているもの)を全て列挙する(オーバーレイ用、着手前局面基準)。 */
function computeDangerousCornerSquares(board: Board): number[] {
  const result: number[] = []
  for (const [square, corner] of [...X_SQUARE_TO_CORNER, ...C_SQUARE_TO_CORNER]) {
    if (cellAt(board, corner) === null) result.push(square)
  }
  return result
}

/**
 * `ctx`から盤面オーバーレイ表示用のマス集合を導出する(要件3)。
 * `stable`(確定石)は`computeStableSquares`(`whyBad.ts`をT032で拡張)を再利用する。
 */
export function computeBoardHighlights(
  ctx: MotifContext,
  computeStableSquares: (board: Board, side: Side) => ReadonlySet<number>,
): BoardHighlights {
  return {
    frontier: [...frontierSquares(ctx.beforeBoard, 'black'), ...frontierSquares(ctx.beforeBoard, 'white')],
    stable: [...computeStableSquares(ctx.beforeBoard, ctx.side)],
    seed: ctx.features.seedStones.map((n) => notationToSquare(n)),
    dangerousCorners: computeDangerousCornerSquares(ctx.beforeBoard),
  }
}
