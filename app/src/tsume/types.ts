/**
 * 詰めオセロモード(T027: 問題生成パイプライン、T028: プレイモードUI)の共通型定義。
 *
 * 設計書 `othello-trainer-design.md` §5「詰めオセロ」の以下2点を実装する:
 * - §5.1「問題形式」: 「黒番(または白番)、最善で+N」形式と「この局面、勝てるか?」形式。
 *   本タスクでは1つの `Puzzle` レコードが両方の出題形式を導出できる情報
 *   (`bestDiscDiff` と `outcome`)を持つ形にし、実際にどちらの文言で出題するかは
 *   UI側(T028)の裁量とする(データを2重に持たない)。
 * - §5.2「問題生成パイプライン」の出力データ形式。
 *
 * 生成パイプライン本体(`puzzlegen/generate.ts`)が `engine/src/bin/puzzlegen.rs`
 * (完全読みで生の着手評価データを計算するRust CLI)の出力を、ここで定義する型に
 * 変換・フィルタ・スコアリングして `app/public/puzzles.json` に書き出す。
 */

import type { Side } from '../game/othello.ts'

/**
 * bigint の盤面を JSON に保存できる形にした表現(16進文字列、`0x`始まり16桁)。
 * `app/src/midgame/types.ts` の `SerializedBoard` と同じ規約
 * (`app/src/engine/hex.ts` の `bigintToHex`/`hexToBigint` で相互変換する)。
 */
export interface SerializedBoard {
  readonly black: string
  readonly white: string
}

/** 出題の勝敗結果(問題の局面の手番から見た結果)。 */
export type PuzzleOutcome = 'win' | 'loss' | 'draw'

/**
 * 手筋タグ(設計書§5.1)。本タスクでは機械的に判定しやすい2種類のみ実装する
 * (「偶数理論」「手止まり」「連打」は簡易判定が困難なため未実装。
 * タスク仕様「本タスクでのスコープ縮小」参照)。
 * - `'corner-sacrifice'`(隅の犠牲): 正解手が、対応する隅がまだ空いている
 *   隅隣接マス(X打ち/C打ち)へのあえての着手であるケース。
 * - `'stable-gain'`(確定石): 正解手を打った後、着手側の確定石数(簡易判定)が
 *   着手前より増えるケース。
 */
export type PuzzleTag = 'corner-sacrifice' | 'stable-gain'

/** 難易度5段階(1が最も易しく、5が最も難しい)。 */
export type DifficultyLevel = 1 | 2 | 3 | 4 | 5

/** 1つの合法手についての完全読み結果・浅い評価・タグ判定用の生データ。 */
export interface PuzzleMove {
  /** "a1"〜"h8" 記法の着手マス。 */
  readonly square: string
  /** この手を打った場合の、出題局面の手番側から見た最終石差(完全読み)。 */
  readonly discDiffForMover: number
  /** この手が最善手(唯一解性フィルタを満たした正解手)の1つであれば `true`。 */
  readonly isBest: boolean
}

/** 詰めオセロ問題1問。 */
export interface Puzzle {
  /** 一意なID。 */
  readonly id: string
  readonly board: SerializedBoard
  /** 出題局面の手番。 */
  readonly sideToMove: Side
  /** 出題局面の空きマス数(6〜20)。 */
  readonly empties: number
  /**
   * 正解手(唯一解性フィルタを満たした、最善結果を維持する手。1〜2個)。
   * "a1"〜"h8" 記法の配列。
   */
  readonly correctMoves: readonly string[]
  /** 最善手を打ち続けた場合の最終石差(出題局面の手番から見て)。「+N」形式に使う。 */
  readonly bestDiscDiff: number
  /** `bestDiscDiff` の符号から導出される勝敗(「勝てるか?」形式に使う)。 */
  readonly outcome: PuzzleOutcome
  /** 次善手(正解手以外で最も結果が良い手)との最終石差の差(明確さフィルタで4以上を保証済み)。 */
  readonly clarityMargin: number
  /** 全合法手の完全読み結果(UIの「失敗時に全候補手の結果一覧を表示」に使う)。 */
  readonly moves: readonly PuzzleMove[]
  readonly difficulty: DifficultyLevel
  /** 難易度算出に使った生スコア(デバッグ・分布確認用。UIでは通常使わない)。 */
  readonly difficultyRawScore: number
  readonly tags: readonly PuzzleTag[]
}

/** `app/public/puzzles.json` 全体の形。 */
export interface PuzzleFile {
  /** 生成日時(ISO文字列)。 */
  readonly generatedAt: string
  readonly puzzles: readonly Puzzle[]
}

/**
 * `engine/src/bin/puzzlegen.rs` の `evaluate` サブコマンドが出す、1候補局面の
 * 1合法手ぶんの生データ(JSON)。フィールド名はRust側の `serde_json::json!` の
 * キー名とそのまま一致させてある。
 */
export interface RawPuzzleGenMove {
  readonly square: string
  readonly valueForMover: number
  readonly shallowEval: number
  readonly cornerSacrificeCandidate: boolean
  readonly stableGain: boolean
}

/** `engine/src/bin/puzzlegen.rs evaluate` が出す、1候補局面ぶんの生データ(JSON)。 */
export interface RawPuzzleGenCandidate {
  readonly id: string
  /** OBF形式(64文字 `X`/`O`/`-`)の盤面文字列。 */
  readonly board: string
  readonly sideToMove: Side
  readonly empties: number
  readonly moves: readonly RawPuzzleGenMove[]
}
