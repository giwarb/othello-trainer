/**
 * 詰めオセロ「デイリー問題」の決定的選択ロジック(設計書§5.2「デイリー問題
 * (日付シードで決定)も同DBから」)。
 *
 * 問題データ自体は事前生成済みのプール(`app/public/puzzles.json`)であり、
 * ここでは「日付文字列から、そのプール内の1問を決定的に選ぶ」純粋関数のみを
 * 実装する(要件9・11)。
 */

/**
 * 文字列をFNV-1a(32bit)でハッシュする。暗号論的な強度は不要で、
 * 「同じ入力なら常に同じ出力になる(決定性)」「異なる日付文字列で
 * 十分ばらける」ことだけが目的の軽量ハッシュ(追加の依存クレート/パッケージを
 * 増やさないため標準的なアルゴリズムを自前実装している。
 * `engine/src/bin/eval_cli.rs` の `Rng` と同様の方針)。
 */
export function hashDateString(dateStr: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < dateStr.length; i++) {
    hash ^= dateStr.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * `dateStr`(例: `"2026-07-09"`)から、長さ `poolLength` のプール内の
 * インデックス(0始まり)を決定的に求める。
 *
 * @throws {RangeError} `poolLength <= 0` の場合。
 */
export function dailyPuzzleIndex(dateStr: string, poolLength: number): number {
  if (poolLength <= 0) {
    throw new RangeError('dailyPuzzleIndex: poolLength must be positive')
  }
  return hashDateString(dateStr) % poolLength
}

/**
 * `dateStr` に対応する1問を `pool` から決定的に選ぶ。
 * 同じ `dateStr`・同じ `pool`(順序も含めて同一)であれば、何度呼び出しても
 * 常に同じ要素を返す(要件11の決定性テスト参照)。
 *
 * @throws {RangeError} `pool` が空配列の場合。
 */
export function dailyPuzzle<T>(dateStr: string, pool: readonly T[]): T {
  if (pool.length === 0) {
    throw new RangeError('dailyPuzzle: pool is empty')
  }
  return pool[dailyPuzzleIndex(dateStr, pool.length)]!
}
