import { useState } from 'preact/hooks'
import { loadApiKey, type ApiKeyReader } from './apiKeyStorage.ts'
import { CommentaryRequestError, requestCommentary } from './client.ts'
import './CommentaryView.css'

export interface CommentaryViewProps {
  /** システムプロンプト(`prompt.ts`の`COMMENTARY_SYSTEM_PROMPT`/`GAME_SUMMARY_SYSTEM_PROMPT`)。 */
  readonly systemPrompt: string
  /** ユーザーメッセージ(`prompt.ts`の`buildCommentaryUserMessage`/`buildGameSummaryUserMessage`)。 */
  readonly userMessage: string
  /** 生成ボタンのラベル(既定「AI講評を生成」)。1局まとめでは呼び出し側で変更する。 */
  readonly buttonLabel?: string
  /** APIキー読み込み元。テスト用の差し替え口(省略時は`window.localStorage`)。 */
  readonly storage?: ApiKeyReader
}

type Phase = 'idle' | 'loading' | 'done' | 'error'

/**
 * 生成された講評の表示コンポーネント(T037、要件5)。
 *
 * APIキーが未設定の場合、生成ボタンの代わりに設定への導線テキストのみを表示し
 * (要件6: 既存機能への影響ゼロ、LLM関連UIは最小限)、実際のAPI呼び出しは一切行わない。
 * `systemPrompt`/`userMessage`は呼び出し側(`BlunderPanel.tsx`/`AnalysisMode.tsx`)が
 * `buildStructuredInput.ts`+`prompt.ts`で組み立てたものをそのまま渡す
 * (本コンポーネント自体は構造化データの組み立てに関与しない、表示専用)。
 */
export function CommentaryView({ systemPrompt, userMessage, buttonLabel = 'AI講評を生成', storage }: CommentaryViewProps) {
  const store = storage ?? window.localStorage
  const apiKey = loadApiKey(store)
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!apiKey) {
    return (
      <p class="commentary-view__hint">
        AI講評はAPIキー未設定のため利用できません(棋譜解析の入力画面にある「AI講評」設定から登録できます)。
      </p>
    )
  }

  async function handleGenerate(): Promise<void> {
    setPhase('loading')
    setErrorMessage(null)
    try {
      const result = await requestCommentary({ apiKey: apiKey!, systemPrompt, userMessage })
      setText(result)
      setPhase('done')
    } catch (error) {
      console.error('AI講評の生成に失敗しました', error)
      const message = error instanceof CommentaryRequestError ? error.message : 'AI講評の生成に失敗しました。'
      setErrorMessage(message)
      setPhase('error')
    }
  }

  return (
    <div class="commentary-view">
      {(phase === 'idle' || phase === 'error') && (
        <button type="button" onClick={() => void handleGenerate()}>
          {phase === 'error' ? '再試行' : buttonLabel}
        </button>
      )}
      {phase === 'loading' && <p class="notice">AI講評を生成中...</p>}
      {phase === 'error' && errorMessage && <p class="notice notice--error">{errorMessage}</p>}
      {phase === 'done' && text && <p class="commentary-view__text">{text}</p>}
    </div>
  )
}
