/**
 * 標準トランスクリプト文字列のパース(T029、要件1・2)。
 *
 * 対応する入力形式: `"f5d6c3d3c4..."`(区切りなし連結)、
 * `"F5 D6, C3; D3-C4"`(大文字/小文字混在・区切り文字混在)など。
 * 「オセロクエストのコピー棋譜」は実際の書式を確認できていないが、座標記法の
 * 羅列であれば本関数でカバーできる想定(タスク仕様の作業ログ参照)。
 *
 * 盤面・合法手には一切依存しない純粋関数。着手が実際にその局面で合法かどうかの
 * 検証は`analyzeGame.ts`の`replayGame`が行う(本関数は記法の形としての妥当性のみを見る)。
 */

/** パースに失敗したときに投げるエラー。 */
export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptParseError'
  }
}

// 区切り文字として許容する文字(空白・カンマ・セミコロン・ハイフン・アンダースコア・
// スラッシュ・矢印風の記号)。これらを除去した残りを2文字ずつの着手記法として扱う。
const SEPARATOR_RE = /[\s,;\-_/→>]+/g

/**
 * 標準トランスクリプト文字列をパースし、`"a1"`〜`"h8"`(小文字)の着手記法の配列に変換する。
 * - 区切り文字混在・大文字小文字混在を許容する。
 * - 区切り文字を除去した結果が空、奇数長、または`a`〜`h`/`1`〜`8`の範囲外を含む場合は
 *   `TranscriptParseError`を投げる。
 */
export function parseTranscript(input: string): string[] {
  const stripped = input.replace(SEPARATOR_RE, '')
  if (stripped.length === 0) {
    throw new TranscriptParseError('棋譜が入力されていません')
  }
  if (stripped.length % 2 !== 0) {
    throw new TranscriptParseError(
      `着手記法を2文字ずつに区切れませんでした(文字数が奇数です): "${stripped}"`,
    )
  }

  const moves: string[] = []
  for (let i = 0; i < stripped.length; i += 2) {
    const chunk = stripped.slice(i, i + 2)
    const file = chunk[0]!.toLowerCase()
    const rank = chunk[1]!
    if (file < 'a' || file > 'h' || rank < '1' || rank > '8') {
      throw new TranscriptParseError(`不正な着手記法です: "${chunk}"(${i / 2 + 1}手目)`)
    }
    moves.push(`${file}${rank}`)
  }
  return moves
}
