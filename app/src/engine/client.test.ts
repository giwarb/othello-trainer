import { describe, expect, it } from 'vitest';
import { EngineClient, type WorkerLike } from './client';
import type { AnalyzeRequestMessage, EngineResponseMessage } from './types';

/**
 * 実際のWorker/WASMを起動せず、リクエストID管理ロジックのみを検証するための
 * フェイクWorker。`postMessage` された内容を記録し、`emit` でテストコードから
 * 任意のタイミングでレスポンスメッセージを配信できる。
 */
class FakeWorker implements WorkerLike {
  readonly sent: AnalyzeRequestMessage[] = [];
  private listener: ((event: MessageEvent) => void) | undefined;
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message as AnalyzeRequestMessage);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    if (this.listener === listener) {
      this.listener = undefined;
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Workerからのレスポンスメッセージが届いたことをシミュレートする。 */
  emit(data: EngineResponseMessage): void {
    this.listener?.({ data } as MessageEvent);
  }
}

function createClient(): { client: EngineClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const client = new EngineClient(() => worker);
  return { client, worker };
}

const board = { black: 0x0000000810000000n, white: 0x0000001008000000n };
const limit = { depth: 6, exactFromEmpties: 24 };

describe('EngineClient', () => {
  it('assigns incrementing request ids and encodes the board as 0x-prefixed hex', async () => {
    const { client, worker } = createClient();

    const promise = client.requestAnalyze(board, 'black', limit);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toEqual({
      id: 1,
      cmd: 'analyze',
      board: {
        black: '0x0000000810000000',
        white: '0x0000001008000000',
        turn: 'black',
      },
      limit,
    });

    worker.emit({
      id: 1,
      final: true,
      depth: 4,
      pv: ['d3'],
      score: { type: 'midgame', discDiff: 0 },
      nodes: 10,
      nps: 1000,
    });

    await expect(promise).resolves.toMatchObject({ id: 1 });

    client.requestAnalyze(board, 'white', limit);
    expect(worker.sent[1]?.id).toBe(2);
  });

  it('resolves multiple concurrent requests to the correct promise, even out of order', async () => {
    const { client, worker } = createClient();

    const first = client.requestAnalyze(board, 'black', limit);
    const second = client.requestAnalyze(board, 'white', limit);

    expect(worker.sent[0]?.id).toBe(1);
    expect(worker.sent[1]?.id).toBe(2);

    // レスポンスが送信順と逆に届いても、idで正しく対応付けられること。
    worker.emit({
      id: 2,
      final: true,
      depth: 5,
      pv: ['c4'],
      score: { type: 'midgame', discDiff: 1 },
      nodes: 20,
      nps: 2000,
    });
    worker.emit({
      id: 1,
      final: true,
      depth: 4,
      pv: ['d3'],
      score: { type: 'midgame', discDiff: 0 },
      nodes: 10,
      nps: 1000,
    });

    await expect(first).resolves.toMatchObject({ id: 1, pv: ['d3'] });
    await expect(second).resolves.toMatchObject({ id: 2, pv: ['c4'] });
  });

  it('rejects the pending request when the worker returns an error response', async () => {
    const { client, worker } = createClient();

    const promise = client.requestAnalyze(board, 'black', limit);
    worker.emit({ id: 1, error: 'invalid request JSON: ...' });

    await expect(promise).rejects.toThrow('invalid request JSON: ...');
  });

  it('ignores error responses whose id could not be determined (id: null)', async () => {
    const { client, worker } = createClient();

    const promise = client.requestAnalyze(board, 'black', limit);
    // idを特定できないエラー(JSON構文エラー等)は無視され、対応するリクエストは
    // 解決されないままになる。後続の正常な応答で該当リクエストが解決されること
    // を確認する。
    worker.emit({ id: null, error: 'invalid request JSON: ...' });
    worker.emit({
      id: 1,
      final: true,
      depth: 4,
      pv: ['d3'],
      score: { type: 'midgame', discDiff: 0 },
      nodes: 10,
      nps: 1000,
    });

    await expect(promise).resolves.toMatchObject({ id: 1 });
  });

  it('terminates the underlying worker and stops listening for messages', () => {
    const { client, worker } = createClient();
    client.terminate();
    expect(worker.terminated).toBe(true);
  });
});
