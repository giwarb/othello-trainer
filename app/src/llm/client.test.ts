import { describe, expect, it, vi } from 'vitest'
import { CommentaryRequestError, requestCommentary } from './client.ts'

/** `fetch`が返す`Response`のうち本モジュールが読む最小限のプロパティだけを持つフェイク。 */
function fakeResponse(init: { ok: boolean; status: number; json?: unknown; text?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.json,
    text: async () => init.text ?? '',
  } as unknown as Response
}

describe('llm/client: requestCommentary', () => {
  it('APIキー未設定(空文字列)の場合はfetchを呼ばずにエラーを投げる', async () => {
    const fetchImpl = vi.fn()
    await expect(
      requestCommentary({ apiKey: '', systemPrompt: 'sys', userMessage: 'user', fetchImpl }),
    ).rejects.toBeInstanceOf(CommentaryRequestError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('成功時、Anthropic Messages APIの正しいエンドポイント・ヘッダー・ボディでfetchし、講評テキストを返す', async () => {
    // 第2引数(RequestInit)を明示的な型で受けることで、`fetchImpl.mock.calls`の要素の型を
    // `typeof fetch`と一致させる(型検査上、実際のfetch呼び出しと同じ引数タプルになる)。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      fakeResponse({ ok: true, status: 200, json: { content: [{ type: 'text', text: 'これは講評です。' }] } }),
    )

    const result = await requestCommentary({
      apiKey: 'sk-ant-dummy-test-key-not-real',
      systemPrompt: 'system-prompt',
      userMessage: 'user-message',
      fetchImpl,
    })

    expect(result).toBe('これは講評です。')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, requestInit] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = requestInit!.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-dummy-test-key-not-real')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    // ブラウザから直接fetchするために必須のヘッダー(BYOK、CORS対応)。
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    const body = JSON.parse(requestInit!.body as string) as {
      system: string
      messages: { role: string; content: string }[]
    }
    expect(body.system).toBe('system-prompt')
    expect(body.messages).toEqual([{ role: 'user', content: 'user-message' }])
  })

  it('ネットワークエラー(fetch自体が失敗)の場合、CommentaryRequestErrorとしてラップして投げる(アプリをクラッシュさせない)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    await expect(
      requestCommentary({ apiKey: 'sk-ant-dummy', systemPrompt: 'sys', userMessage: 'user', fetchImpl }),
    ).rejects.toThrow(CommentaryRequestError)
  })

  it('APIキーが無効(401)の場合、分かりやすいエラーメッセージを投げる', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 401, text: 'unauthorized' }))
    await expect(
      requestCommentary({ apiKey: 'sk-ant-invalid', systemPrompt: 'sys', userMessage: 'user', fetchImpl }),
    ).rejects.toThrow(/APIキーが無効/)
  })

  it('レート制限(429)の場合、分かりやすいエラーメッセージを投げる', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 429, text: 'rate limited' }))
    await expect(
      requestCommentary({ apiKey: 'sk-ant-dummy', systemPrompt: 'sys', userMessage: 'user', fetchImpl }),
    ).rejects.toThrow(/レート制限/)
  })

  it('応答にtextブロックが含まれない場合、フォールバックのエラーを投げる', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: true, status: 200, json: { content: [] } }))
    await expect(
      requestCommentary({ apiKey: 'sk-ant-dummy', systemPrompt: 'sys', userMessage: 'user', fetchImpl }),
    ).rejects.toThrow(/講評テキストが含まれていません/)
  })
})
