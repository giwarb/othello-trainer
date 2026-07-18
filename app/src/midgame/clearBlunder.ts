/**
 * T128: 中盤練習モード「1手先対比の明確悪手判定」用の悪化パターン検出モジュール。
 *
 * 背景(ユーザー指示 2026-07-18朝): 中盤練習の学習価値の核心は「自分が打った
 * 直後(相手番)の形が、自分にとって良い形かを言語化できること」。従来の
 * 悪手判定は評価値差(`judgeMidgameMove`)のみに基づいており、深く読まないと
 * 説明できない微差でも問答無用で不合格になっていた。本モジュールは、実際に
 * 打った手の後の局面(相手番)と最善手の後の局面(同じく相手番)を、既存の
 * 12特徴量(`engine/src/explain.rs::compute_features`、`FeatureSet`)・
 * 15モチーフ(`analysis/motifs.ts`)・盤面ルール(`game/othello.ts`の合法手
 * 計算そのもの。これは深い探索ではなく1手先の局面を作るだけの操作)の範囲
 * だけで比較し、**専門用語を使わずに対比で説明できる悪化パターンが1件以上
 * 見つかったときだけ**結果を返す純粋関数群を提供する。
 *
 * 各検出器(`detect*`関数)は`motifs.ts`の`detect*`系と同じ設計方針
 * (`ClearBlunderInput`という1つの入力から必要な派生値を自分で計算する、
 * 独立した純粋関数)に揃えている。新たなエンジン呼び出し・深い探索は
 * 一切行わない(呼び出し元が`requestFeatureSet`で取得済みの`FeatureSet`を
 * 渡す設計)。1手先の特徴量・モチーフだけで説明がつかない差では
 * `detectClearBlunderPatterns`が`null`を返し、呼び出し元
 * (`midgame/PracticeMode.tsx`)がそれを「合格」として扱う
 * (ユーザー裁定: 「最善手と悪手の差が言語化できないこともある。その時は
 * 悪手と判定しなくてもよい」)。
 */

import { analyzeWhyBad, computeStableSquares } from '../analysis/whyBad.ts'
import { detectCUchi, detectXUchi, frontierSquares, type MotifContext } from '../analysis/motifs.ts'
import type { FeatureSet } from '../analysis/types.ts'
import {
  applyMove,
  cellAt,
  countEmpty,
  legalMoves,
  notationToSquare,
  opposite,
  squareToNotation,
  type Board,
  type Side,
} from '../game/othello.ts'

/**
 * 検出しうる明確な悪化パターンの種別(要件1の表と対応)。
 *
 * T128b(`tasks/T128b-clear-patterns-wave2.md`、設計諮問レポート
 * `tasks/design/T128-clear-patterns-report.md`の第1波推奨4件をオーケストレーター
 * 裁定により採用)で`missed-corner`/`opponent-pass-missed`/
 * `own-mobility-collapse`/`mass-flip`の4種を追加した。
 */
export type ClearBlunderPatternId =
  | 'opponent-mobility'
  | 'corner-gift'
  | 'x-c-danger'
  | 'wall-frontier'
  | 'stable-loss'
  | 'missed-corner'
  | 'opponent-pass-missed'
  | 'own-mobility-collapse'
  | 'mass-flip'

/**
 * 検出された1件の明確な悪化パターン。`message`は専門用語を使わない平易な
 * 日本語(要件4)。`playedHighlightSquares`/`bestHighlightSquares`は、
 * それぞれ「あなたの手のあと」「最善手のあと」の盤面上でハイライトすべき
 * マス(要件3、無ければ空配列)。
 */
export interface ClearBlunderPattern {
  readonly id: ClearBlunderPatternId
  readonly message: string
  /**
   * 複数検出時に「影響の大きい順に最大2件」(要件1)を選ぶためだけに使う
   * 内部的な重要度の目安。パターンごとに単位が異なる(合法手数の個数・
   * 確定石の個数・固定の重み)ため、パターン間の比較は厳密な評価値ではなく
   * 実装者判断の近似順序である。表示はしない。
   */
  readonly severity: number
  readonly playedHighlightSquares: readonly number[]
  readonly bestHighlightSquares: readonly number[]
}

/**
 * 各`detect*`検出器・`detectClearBlunderPatterns`への統一入力。着手前局面・
 * 実際の手・最善手の3点と、両手の特徴量(`requestFeatureSet`の応答)。
 */
export interface ClearBlunderInput {
  readonly preMoveBoard: Board
  readonly preMoveSide: Side
  readonly playedSquare: number
  readonly bestSquare: number
  /** `requestFeatureSet(preMoveBoard, preMoveSide, playedMoveNotation)`の`features`。 */
  readonly playedFeatures: FeatureSet
  /** `requestFeatureSet(preMoveBoard, preMoveSide, bestMoveNotation)`の`features`。 */
  readonly bestFeatures: FeatureSet
}

/** 隅4マス(a1, h1, a8, h8)のマス番号。 */
const CORNER_SQUARES: readonly number[] = [0, 7, 56, 63]

/** `detectClearBlunderPatterns`が返す最大件数(要件1)。 */
const MAX_PATTERNS = 2

function opponentSideOf(input: ClearBlunderInput): Side {
  return opposite(input.preMoveSide)
}

function boardAfterPlayed(input: ClearBlunderInput): Board {
  return applyMove(input.preMoveBoard, input.preMoveSide, input.playedSquare)
}

function boardAfterBest(input: ClearBlunderInput): Board {
  return applyMove(input.preMoveBoard, input.preMoveSide, input.bestSquare)
}

// ---------------------------------------------------------------------
// opponent-mobility: 相手の合法手数の差
// ---------------------------------------------------------------------

/**
 * 閾値3の根拠: 標準モードの許容ロス(石差1.0)程度の僅差は「深読みしないと
 * 説明できない微差」になりやすく、合法手数1〜2個程度の違いは(具体的な
 * マスの中身次第で)必ずしも悪化とは言えない。3か所以上の差であれば
 * 「相手の選択肢が一目でわかるほど広がった」と平易に説明できる規模と判断した
 * 実装者判断の閾値。
 */
export const OPPONENT_MOBILITY_THRESHOLD = 3

export function detectOpponentMobility(input: ClearBlunderInput): ClearBlunderPattern | null {
  const opponentSide = opponentSideOf(input)
  const playedMoves = legalMoves(boardAfterPlayed(input), opponentSide)
  const bestMoves = legalMoves(boardAfterBest(input), opponentSide)
  const diff = playedMoves.length - bestMoves.length
  if (diff < OPPONENT_MOBILITY_THRESHOLD) return null
  return {
    id: 'opponent-mobility',
    message: `この手の後、相手は${playedMoves.length}か所に打てます。最善手なら${bestMoves.length}か所でした。`,
    severity: diff,
    playedHighlightSquares: playedMoves,
    bestHighlightSquares: bestMoves,
  }
}

// ---------------------------------------------------------------------
// corner-gift: 相手に隅を取られる/取られない
// ---------------------------------------------------------------------

/**
 * 重要度の固定値: 隅は1個で複数の確定石に直結しうる、他の指標とは質の異なる
 * 損失であるため、合法手数差・確定石差の典型的な値幅より大きい固定値を
 * 割り当てて優先表示されやすくした実装者判断。
 */
export const CORNER_GIFT_SEVERITY = 10

/**
 * 「afterPlayedでは相手の合法手に隅が含まれ、afterBestでは含まれない」
 * (要件1の表)をそのまま、着手後局面での相手の合法手一覧(`legalMoves`、
 * 1手先の盤面ルール適用であり深読みではない)で判定する。
 */
export function detectCornerGift(input: ClearBlunderInput): ClearBlunderPattern | null {
  const opponentSide = opponentSideOf(input)
  const playedOppMoves = legalMoves(boardAfterPlayed(input), opponentSide)
  const bestOppMoves = legalMoves(boardAfterBest(input), opponentSide)
  const playedCorner = CORNER_SQUARES.find((sq) => playedOppMoves.includes(sq))
  const bestHasCorner = CORNER_SQUARES.some((sq) => bestOppMoves.includes(sq))
  if (playedCorner === undefined || bestHasCorner) return null
  return {
    id: 'corner-gift',
    message: `この手だと相手に隅(${squareToNotation(playedCorner)})を取られます。最善手なら取られませんでした。`,
    severity: CORNER_GIFT_SEVERITY,
    playedHighlightSquares: [playedCorner],
    bestHighlightSquares: [],
  }
}

// ---------------------------------------------------------------------
// x-c-danger: 実際の手がX/C打ちで、最善手はそうでない
// ---------------------------------------------------------------------

/** 固定重み: 確実な損失(corner-gift)ほどではないが明確な危険手のため、合法手数差の典型値より少し上に置いた実装者判断。 */
export const X_C_DANGER_SEVERITY = 6

/**
 * 既存モチーフ検出(`analysis/motifs.ts`の`detectXUchi`/`detectCUchi`、
 * `whyBad.ts`の`analyzeWhyBad`を内部で再利用)をそのまま流用する(要件1の
 * 表の指示どおり)。
 */
export function detectXCDanger(input: ClearBlunderInput): ClearBlunderPattern | null {
  const playedMotifCtx: MotifContext = {
    beforeBoard: input.preMoveBoard,
    side: input.preMoveSide,
    square: input.playedSquare,
    features: input.playedFeatures,
  }
  const bestMotifCtx: MotifContext = {
    beforeBoard: input.preMoveBoard,
    side: input.preMoveSide,
    square: input.bestSquare,
    features: input.bestFeatures,
  }

  const playedIsX = detectXUchi(playedMotifCtx)
  const playedIsC = detectCUchi(playedMotifCtx)
  if (!playedIsX && !playedIsC) return null
  if (detectXUchi(bestMotifCtx) || detectCUchi(bestMotifCtx)) return null

  const cornerRisk = analyzeWhyBad(input.preMoveBoard, input.preMoveSide, input.playedSquare).cornerRisk
  const cornerSquare = cornerRisk ? notationToSquare(cornerRisk.corner) : null
  const message = playedIsX
    ? '隅がまだ空いているのに、その斜め隣(X)に打つと隅を取られやすくなります。'
    : '隅がまだ空いているのに、その隣(C)に打つと隅を取られやすくなります。'

  return {
    id: 'x-c-danger',
    message,
    severity: X_C_DANGER_SEVERITY,
    playedHighlightSquares: cornerSquare !== null ? [input.playedSquare, cornerSquare] : [input.playedSquare],
    bestHighlightSquares: [],
  }
}

// ---------------------------------------------------------------------
// wall-frontier: フロンティア石(外側に露出した自石)の増加差
// ---------------------------------------------------------------------

/**
 * 閾値4の根拠: 着手そのものが盤の開いた領域の近くで行われることが多く、
 * 1〜3個程度の増加は通常の着手でもありふれている(`motifs.ts`の
 * `detectKabezukuri`が単独局面比較で閾値2を採用しているのと同種の理由)。
 * 本パターンは「最善手との差」を見るため、単独局面比較よりも一段階厳しい
 * 閾値(4)を実装者判断で採用し、一目でわかる規模の差に絞った。
 */
export const WALL_FRONTIER_THRESHOLD = 4

export function detectWallFrontier(input: ClearBlunderInput): ClearBlunderPattern | null {
  const playedFrontier = frontierSquares(boardAfterPlayed(input), input.preMoveSide)
  const bestFrontier = frontierSquares(boardAfterBest(input), input.preMoveSide)
  const diff = playedFrontier.length - bestFrontier.length
  if (diff < WALL_FRONTIER_THRESHOLD) return null
  return {
    id: 'wall-frontier',
    message: 'この手は自分の石を外側にさらします(壁)。相手から攻めやすい形です。',
    severity: diff,
    playedHighlightSquares: playedFrontier,
    bestHighlightSquares: bestFrontier,
  }
}

// ---------------------------------------------------------------------
// stable-loss: 確定石の差
// ---------------------------------------------------------------------

/**
 * 閾値2の根拠: 確定石1個の差は終盤に近づくほど頻繁に生じるありふれた差で
 * あり、2個以上の差であれば「明確に損をした」と言える規模と判断した
 * 実装者判断の閾値。
 */
export const STABLE_LOSS_THRESHOLD = 2

export function detectStableLoss(input: ClearBlunderInput): ClearBlunderPattern | null {
  // `FeatureSet.stableDiff`は「preMoveSide視点の確定石差(着手後局面、
  // 自分の確定石数 - 相手の確定石数)」(`engine/src/explain.rs`参照)。
  // playedFeatures/bestFeaturesはいずれも同じ`preMoveSide`・同じ着手前局面
  // から計算されているため、着手だけを変数にした厳密な比較になる。
  const diff = input.bestFeatures.stableDiff - input.playedFeatures.stableDiff
  if (diff < STABLE_LOSS_THRESHOLD) return null
  return {
    id: 'stable-loss',
    message: `最善手なら確定石(絶対に取られない石)が${diff}個増えていました。`,
    severity: diff,
    playedHighlightSquares: [...computeStableSquares(boardAfterPlayed(input), input.preMoveSide)],
    bestHighlightSquares: [...computeStableSquares(boardAfterBest(input), input.preMoveSide)],
  }
}

// ---------------------------------------------------------------------
// missed-corner: 最善手が隅なのに取らなかった(T128b①)
// ---------------------------------------------------------------------

/**
 * 重要度: `corner-gift`(10、相手に隅を取られる)に次ぐ「隅系」として、
 * オーケストレーター裁定(`tasks/T128b-clear-patterns-wave2.md`)により
 * `corner-gift`の次点(`opponent-pass-missed`より上位)に置く。設計レポート
 * (`tasks/design/T128-clear-patterns-report.md`)の生の提案値(8)は
 * `opponent-pass-missed`(9)より低かったが、裁定「優先順位は隅の取り逃し>
 * パス取り逃し」を反映し、本パターンを`opponent-pass-missed`より高くした。
 */
export const MISSED_CORNER_SEVERITY = 9

/**
 * 「最善手が隅で、実際の手は隅ではない」ことを直接判定する(閾値不要。
 * 設計レポート§(a)①参照: エンジンが「隅が最善」と言っている事実そのものが
 * 根拠であり、「隅=常に良い」という一般論を機械的に適用しているわけではない
 * ため誤検出リスクが無い)。
 */
export function detectMissedCorner(input: ClearBlunderInput): ClearBlunderPattern | null {
  if (!CORNER_SQUARES.includes(input.bestSquare) || CORNER_SQUARES.includes(input.playedSquare)) return null
  const corner = input.bestSquare
  return {
    id: 'missed-corner',
    message: `隅(${squareToNotation(corner)})を取れるのに取りませんでした。隅は一度取るとひっくり返されない、いちばん強いマスです。`,
    severity: MISSED_CORNER_SEVERITY,
    // 「あなたの手のあと」盤面でも「最善手のあと」盤面でも同じ隅マスをハイライトし、
    // 一方は空きのまま・もう一方は取られている、という対比を見せる(設計レポート参照)。
    playedHighlightSquares: [corner],
    bestHighlightSquares: [corner],
  }
}

// ---------------------------------------------------------------------
// opponent-pass-missed: 最善手なら相手の合法手が0(パス)だった(T128b②)
// ---------------------------------------------------------------------

/**
 * 重要度: パス強制は隅級のテンポ利得だが、`missed-corner`(9、裁定により
 * 隅系を最上位に寄せる)より下位に置く(設計レポートの生の提案値は9で
 * `missed-corner`と同値だったが、オーケストレーター裁定の優先順位
 * 「隅の取り逃し>パス取り逃し」を反映し1段下げた)。既存`x-c-danger`(6)
 * よりは上位(パス強制の確実性は危険手より重いと判断)。
 */
export const OPPONENT_PASS_MISSED_SEVERITY = 8

/**
 * 「最善手の後は相手の合法手が0(パス)だが、実際の手の後は相手に合法手が
 * ある」ことを判定する(閾値不要)。既存`opponent-mobility`は差3以上でしか
 * 発火しないため、「2→0」のような小差のパス逃しを取りこぼす穴があった
 * (設計レポート§(a)②)。独立した検出器にすることで、メッセージ・severityを
 * `opponent-mobility`と分離する。
 */
export function detectOpponentPassMissed(input: ClearBlunderInput): ClearBlunderPattern | null {
  const opponentSide = opponentSideOf(input)
  const playedOppMoves = legalMoves(boardAfterPlayed(input), opponentSide)
  const bestOppMoves = legalMoves(boardAfterBest(input), opponentSide)
  if (bestOppMoves.length !== 0 || playedOppMoves.length === 0) return null
  return {
    id: 'opponent-pass-missed',
    message: `最善手なら相手は打てる場所がなくパスでした。続けてあなたの番になれたのに、この手だと相手は${playedOppMoves.length}か所に打てます。`,
    severity: OPPONENT_PASS_MISSED_SEVERITY,
    playedHighlightSquares: playedOppMoves,
    bestHighlightSquares: [],
  }
}

// ---------------------------------------------------------------------
// own-mobility-collapse: 自分の打てる場所の激減(T128b③)
// ---------------------------------------------------------------------

/**
 * 差の閾値3: 既存`OPPONENT_MOBILITY_THRESHOLD`(相手側の差、同じく3)と対称に
 * 揃えた実装者判断(設計レポート§(a)③)。
 */
export const OWN_MOBILITY_COLLAPSE_DIFF_THRESHOLD = 3

/**
 * 着手後の自分の絶対手数の上限4: 「10→7」のような、まだ余裕がある減少では
 * 発火させず、「一目で苦しいと分かる」場面(打てる場所が片手で数えられる
 * 程度)に絞るための追加条件(設計レポート§(a)③、`OPPONENT_MOBILITY_THRESHOLD`
 * には無い本パターン固有の条件)。
 */
export const OWN_MOBILITY_COLLAPSE_MAX_ABS = 4

/**
 * `FeatureSet.moverMobilityAfter`(着手後局面で、着手した側が次に手番が
 * 回ってきたときに持つ合法手の数。既存フィールド、設計レポートが指摘する
 * 「エンジンから既に取得済みの値」)を両手について比較する。着手直後は
 * 相手番であり、相手の応手を経ないと実際の手数は変わりうる近似だが、
 * 既存`opponent-mobility`と同水準の近似であり許容する(設計レポート§(a)③の
 * 「正直さの注意点」参照)。
 */
export function detectOwnMobilityCollapse(input: ClearBlunderInput): ClearBlunderPattern | null {
  const playedOwn = input.playedFeatures.moverMobilityAfter
  const bestOwn = input.bestFeatures.moverMobilityAfter
  const diff = bestOwn - playedOwn
  if (diff < OWN_MOBILITY_COLLAPSE_DIFF_THRESHOLD || playedOwn > OWN_MOBILITY_COLLAPSE_MAX_ABS) return null
  const message =
    playedOwn === 0
      ? `この手の後、あなたが打てる場所がなくなり、パスになるおそれがあります。最善手なら${bestOwn}か所ありました。`
      : `この手の後、あなたが打てる場所は${playedOwn}か所しかありません。最善手なら${bestOwn}か所ありました。`
  return {
    id: 'own-mobility-collapse',
    message,
    severity: diff,
    playedHighlightSquares: legalMoves(boardAfterPlayed(input), input.preMoveSide),
    bestHighlightSquares: legalMoves(boardAfterBest(input), input.preMoveSide),
  }
}

// ---------------------------------------------------------------------
// mass-flip: 石の取りすぎ(大量返し、T128b④)
// ---------------------------------------------------------------------

/**
 * 着手前後で`side`の石になった(=`before`では相手の石だった)マス番号一覧を
 * 返す(新しく置いた着手マス自体は`before`で空きだったため対象外、自然に
 * 除外される)。
 */
function flippedSquares(before: Board, after: Board, side: Side): number[] {
  const opp = opposite(side)
  const result: number[] = []
  for (let sq = 0; sq < 64; sq++) {
    if (cellAt(before, sq) === opp && cellAt(after, sq) === side) result.push(sq)
  }
  return result
}

/**
 * 差の閾値4: 序中盤の最善手のフリップ数は1〜3個が典型(中割り志向)なので、
 * 差4以上なら「取りすぎ」と一目で言える規模とした実装者判断
 * (設計レポート§(a)④)。
 */
export const MASS_FLIP_DIFF_THRESHOLD = 4

/**
 * 着手前局面の空きマス数がこれ未満なら判定しない(適用範囲のガード)。
 * 終盤に近づくほど多く返すのが正しい局面が増えるため、序中盤(中盤練習の
 * 手数帯)に限定する安全弁。オーケストレーター裁定によりレポート提案値
 * (16)をそのまま採用した(設計レポート§(a)④・確認事項1)。
 */
export const MASS_FLIP_MIN_EMPTY = 16

export function detectMassFlip(input: ClearBlunderInput): ClearBlunderPattern | null {
  if (countEmpty(input.preMoveBoard) < MASS_FLIP_MIN_EMPTY) return null
  const playedFlips = flippedSquares(input.preMoveBoard, boardAfterPlayed(input), input.preMoveSide)
  const bestFlips = flippedSquares(input.preMoveBoard, boardAfterBest(input), input.preMoveSide)
  const diff = playedFlips.length - bestFlips.length
  if (diff < MASS_FLIP_DIFF_THRESHOLD) return null
  return {
    id: 'mass-flip',
    message: `この手は一度に${playedFlips.length}個も返しています(最善手は${bestFlips.length}個)。序盤・中盤で石をたくさん返すと、あとで相手に返され放題の形になりやすいです。`,
    severity: diff,
    playedHighlightSquares: playedFlips,
    bestHighlightSquares: bestFlips,
  }
}

// ---------------------------------------------------------------------
// 統合エントリポイント
// ---------------------------------------------------------------------

/**
 * `input`から明確な悪化パターンを検出する(要件1・2)。1件も検出されなければ
 * `null`(=明確な説明不能。呼び出し元はこれを「合格」として扱う)。複数検出時は
 * `severity`降順で最大`MAX_PATTERNS`(2)件を返す。
 */
export function detectClearBlunderPatterns(input: ClearBlunderInput): readonly ClearBlunderPattern[] | null {
  const detected = [
    detectOpponentMobility(input),
    detectCornerGift(input),
    detectXCDanger(input),
    detectWallFrontier(input),
    detectStableLoss(input),
    detectMissedCorner(input),
    detectOpponentPassMissed(input),
    detectOwnMobilityCollapse(input),
    detectMassFlip(input),
  ].filter((pattern): pattern is ClearBlunderPattern => pattern !== null)

  if (detected.length === 0) return null
  return [...detected].sort((a, b) => b.severity - a.severity).slice(0, MAX_PATTERNS)
}
