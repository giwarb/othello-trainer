/**
 * T037「任意LLM解説層」(`othello-trainer-design-verbalization.md` §9)の
 * プロンプトテンプレート。
 *
 * # ハルシネーション防止の核心
 * 設計書§9は「LLMの役割は事実生成ではなく文章化のみに限定し、プロンプトで
 * 『与えられた分析事実以外を述べない』と拘束する」と明記している。本モジュールの
 * システムプロンプトはこの拘束を明文化したものであり、`buildStructuredInput.ts`が
 * 組み立てた構造化データ(`StructuredCommentaryInput`/`StructuredGameSummaryInput`)
 * だけをJSONとしてユーザーメッセージに埋め込み、LLMにはその文章化のみを求める。
 * 盤面の生画像やマス目の座標そのものを別途渡すことはしない(構造化データに含まれる
 * 記法("a1"等)以外の盤面情報をLLMに与えない、実装者判断のスコープ)。
 */

import type { StructuredCommentaryInput, StructuredGameSummaryInput } from './types.ts'

/** 悪手1手ぶんの講評生成用システムプロンプト(要件3)。 */
export const COMMENTARY_SYSTEM_PROMPT = `あなたはオセロ(リバーシ)のコーチです。ユーザーが打った1手の悪手について、
与えられた「分析事実」(JSON形式)だけを根拠に、日本語で3〜4文程度の講評を書いてください。

厳守事項(最重要):
- 分析事実のJSONに書かれていない情報を新たに作り出さないでください。具体的なマス目の座標や
  戦術、数値、手順で、JSON中に明示的に記載が無いものには一切言及しないでください。
- JSON中の数値・タグ名・手順をそのまま自然文に言い換えることに徹してください。事実の解釈や
  一般的なオセロの知識の当てはめは避け、あくまでJSONに書かれた事実の言語化に留めてください。
- 断定できるのはJSONに明示された事実のみです。それ以外は述べないでください。
- 出力は日本語の講評本文のみとし、JSON・マークダウンの見出し・箇条書き記号は含めないでください。
- moveTags/motifTags等のkeyが日本語ラベル(label)を持つ場合は、labelを使って自然に言い換えてください。`

/** 1局まとめの感想戦テキスト生成用システムプロンプト(要件5)。 */
export const GAME_SUMMARY_SYSTEM_PROMPT = `あなたはオセロ(リバーシ)のコーチです。ユーザーが指した1局について、
与えられた「分析事実」(JSON形式、目立った手の一覧)だけを根拠に、日本語で1局分の感想戦テキストを
5〜8文程度で書いてください。

厳守事項(最重要):
- 分析事実のJSONに書かれていない情報を新たに作り出さないでください。JSONに記載の無い具体的な
  マス目・戦術・数値には一切言及しないでください。
- JSON中の数値・分類・手順をそのまま自然文に言い換えることに徹してください。
- 出力は日本語の感想戦テキスト本文のみとし、JSON・マークダウンの見出し・箇条書き記号は含めないでください。`

/** 悪手1手ぶんの講評生成用ユーザーメッセージ(構造化入力をJSONのまま埋め込む)。 */
export function buildCommentaryUserMessage(input: StructuredCommentaryInput): string {
  return [
    'この手についての分析事実は以下のJSONの通りです。この事実だけを根拠に、悪手の講評を3〜4文で書いてください。',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
  ].join('\n')
}

/** 1局まとめの感想戦テキスト生成用ユーザーメッセージ。 */
export function buildGameSummaryUserMessage(input: StructuredGameSummaryInput): string {
  return [
    'この対局についての分析事実(目立った手の一覧)は以下のJSONの通りです。',
    'この事実だけを根拠に、1局分の感想戦テキストを5〜8文で書いてください。',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
  ].join('\n')
}
