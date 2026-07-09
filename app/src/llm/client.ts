/**
 * T037「任意LLM解説層」のLLM APIクライアント(要件4)。
 *
 * # プロバイダ選定: Anthropic Claude API
 * 実装前に確認した通り、Anthropic Messages API(`https://api.anthropic.com/v1/messages`)は
 * `anthropic-dangerous-direct-browser-access: true`ヘッダーを付与することで、ブラウザの
 * JavaScriptから直接fetchできる(CORS対応済み、公式にサポートされたBYOKユースケース。
 * ヘッダー名の「dangerous」は「ブラウザの開発者ツールからAPIキーが見える」ことを利用者に
 * 明示的に自覚させる意図であり、BYOK(キーの持ち主が自分のブラウザで使う)用途では
 * 許容される設計と説明されている)。これにより、プロキシサーバーの新規構築
 * (本プロジェクトのスコープ外)無しにBYOKを実現できる。
 *
 * # セキュリティ
 * APIキーは呼び出し元(`apiKeyStorage.ts`経由でlocalStorageから読み込んだもの)から
 * この関数に渡され、Anthropicの公式エンドポイントへ`x-api-key`ヘッダーとして直接送るのみ。
 * 本アプリのサーバー(存在しない、GitHub Pages静的配信のみ)には一切送信されない。
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 講評文生成に使うモデル。悪手1つにつき3〜4文/1局まとめで5〜8文程度の短い日本語文章生成
 * であり、最高性能モデルは不要と判断し、コストと日本語品質のバランスが良いSonnet系
 * (`claude-sonnet-5`)を採用する(実装者判断、タスク仕様「LLMプロバイダは1つに絞ってよい」
 * の範囲内)。
 */
export const COMMENTARY_MODEL = 'claude-sonnet-5'

/** 講評文の分量(3〜8文程度)に対して十分な余裕を持たせた上限。 */
const MAX_TOKENS = 600

/** LLM API呼び出しの失敗(ネットワークエラー・APIエラー・応答形式異常)を表す例外。 */
export class CommentaryRequestError extends Error {
  /**
   * 本プロジェクトのビルド設定(`erasableSyntaxOnly`)ではコンストラクタ引数の
   * パラメータプロパティ構文(`readonly cause?: unknown`)が使えないため、
   * 通常のフィールド宣言+コンストラクタ内代入にしている
   * (`TranscriptReplayError`等、既存の例外クラスと同じ`extends Error`パターン)。
   */
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CommentaryRequestError'
    this.cause = cause
  }
}

export interface RequestCommentaryOptions {
  /** ユーザーが設定したAnthropic APIキー(`apiKeyStorage.ts`経由でlocalStorageから読み込んだもの)。 */
  readonly apiKey: string
  readonly systemPrompt: string
  readonly userMessage: string
  /** テスト用のfetch差し替え口(省略時は`globalThis.fetch`)。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * Anthropic Messages APIをブラウザから直接呼び出し、講評テキストを1つ返す(要件4)。
 * ネットワークエラー・APIエラー(無効なキー・レート制限等)・応答形式の異常はいずれも
 * `CommentaryRequestError`として投げる(呼び出し側でキャッチしてフォールバック表示する)。
 */
export async function requestCommentary(options: RequestCommentaryOptions): Promise<string> {
  const { apiKey, systemPrompt, userMessage, fetchImpl = globalThis.fetch } = options

  if (apiKey.trim().length === 0) {
    throw new CommentaryRequestError('APIキーが設定されていません。')
  }

  let response: Response
  try {
    response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: COMMENTARY_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
  } catch (error) {
    throw new CommentaryRequestError('LLM APIへの通信に失敗しました。ネットワーク接続を確認してください。', error)
  }

  if (!response.ok) {
    throw new CommentaryRequestError(await describeErrorResponse(response))
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    throw new CommentaryRequestError('LLM APIの応答を解析できませんでした。', error)
  }

  const text = extractText(json)
  if (text === null) {
    throw new CommentaryRequestError('LLM APIの応答に講評テキストが含まれていませんでした。')
  }
  return text
}

/** HTTPステータスに応じた分かりやすいエラーメッセージを組み立てる。 */
async function describeErrorResponse(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return 'APIキーが無効です。設定画面でAPIキーを確認してください。'
  }
  if (response.status === 429) {
    return 'レート制限に達しました。しばらく待ってから再試行してください。'
  }
  if (response.status >= 500) {
    return `LLM APIが一時的に利用できません(status ${response.status})。しばらく待ってから再試行してください。`
  }
  const bodyText = await response.text().catch(() => '')
  return `LLM APIがエラーを返しました(status ${response.status})。${bodyText}`.trim()
}

/** Messages APIの応答(`{content: [{type: "text", text: "..."}]}`)からテキストを取り出す。 */
function extractText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null
  const content = (json as Record<string, unknown>).content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
  }
  return null
}
