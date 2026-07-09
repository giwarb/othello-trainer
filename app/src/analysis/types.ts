/**
 * 棋譜解析モード(T029)の型定義。
 *
 * 設計書 `othello-trainer-design.md` §6「棋譜解析(評価グラフ・悪手分析)」の
 * うち§6.1「入力」・§6.2「解析パイプライン」・§6.3「評価グラフUI」に対応する。
 * 悪手分析パネル(比較PV・フリー分岐探索等)はT030のスコープであり、
 * 本タスクでは扱わない。
 */

import type { Board, Side } from '../game/othello.ts'

/** 入力された1局の棋譜(着手列、`parseTranscript`の出力または手動並べの記録)。 */
export interface GameRecord {
  readonly moves: readonly string[]
}

/**
 * ロス量から分類した手の評価(要件4)。
 * - `'best'`: ロス1.0石未満(最善/準最善、◎)
 * - `'inaccuracy'`: ロス1.0〜3.0石未満(緩手、?!)
 * - `'dubious'`: ロス3.0〜6.0石未満(疑問手、?)
 * - `'blunder'`: ロス6.0石以上(悪手、??)
 *
 * 「逆転悪手」は`MoveAnalysis.reversal`で別軸として表現する(このいずれの
 * 分類とも独立に立ちうる、赤強調用のフラグ)。
 */
export type MoveClassification = 'best' | 'inaccuracy' | 'dubious' | 'blunder'

/**
 * 1手ごとの解析結果。`ply`は0始まりの手数(0 = 最初の着手)。
 *
 * 評価値(`bestDiscDiff`/`playedDiscDiff`)は着手前局面の手番(`side`)視点。
 * `blackAdvantageBefore`/`blackAdvantageAfter`は黒視点に統一した値で、
 * グラフ描画(§6.3、黒優勢を上に)と逆転判定の両方に使う。
 */
export interface MoveAnalysis {
  readonly ply: number
  /** この手の記法("a1"〜"h8")。 */
  readonly move: string
  /** この手を打った側。 */
  readonly side: Side
  /** 着手前の局面。 */
  readonly board: Board
  /** 着手前局面の解析(最善手の評価)が完全読みだったか(空き22以下)。 */
  readonly isExact: boolean
  /** 着手前局面における最善手の記法。 */
  readonly bestMove: string
  /** 最善手の評価値(石差、`side`視点)。 */
  readonly bestDiscDiff: number
  /** 実際に打った手の評価値(石差、`side`視点)。 */
  readonly playedDiscDiff: number
  /** 最善手とのロス(石差、0以上)。 */
  readonly lossDiscs: number
  /** ロス量に基づく分類。 */
  readonly classification: MoveClassification
  /** この手によって黒視点の優勢/劣勢(符号)が入れ替わったか(逆転悪手)。 */
  readonly reversal: boolean
  /** 着手前局面の評価値(黒視点)。 */
  readonly blackAdvantageBefore: number
  /** 着手後局面の評価値(黒視点。次の手の`blackAdvantageBefore`、または最終局面なら確定石差)。 */
  readonly blackAdvantageAfter: number
}

/** `analyzeGame`の進捗コールバックに渡す情報(要件3: 解析中の進捗表示)。 */
export interface AnalyzeGameProgress {
  /** 解析が完了した手の数(1〜`total`まで増加していく)。 */
  readonly done: number
  /** 解析対象の総手数。 */
  readonly total: number
  /** 直前に解析が完了した手の`ply`(終局側から解析するため`total-1`から`0`へ向けて減っていく)。 */
  readonly justAnalyzedPly: number
}

/** 分類の閾値(要件4、ユーザー設定可能)。単位は石差。 */
export interface ClassifyThresholds {
  /** この値以上で「緩手」(?!)。 */
  readonly inaccuracy: number
  /** この値以上で「疑問手」(?)。 */
  readonly dubious: number
  /** この値以上で「悪手」(??)。 */
  readonly blunder: number
}
