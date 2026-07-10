import { afterEach, describe, expect, it } from 'vitest';
import { getSharedEngineClient, resetSharedEngineClientForTest, terminateSharedEngineClient } from './sharedClient';
import type { WorkerLike } from './client';
import type { EngineRequestMessage, EngineResponseMessage } from './types';

/**
 * `client.test.ts` と同じフェイクWorker。ここでは「何回Workerが生成されたか」
 * を数えるのが目的なので、`createWorker` 呼び出し自体をラップして数える
 * (下記 `createCountingWorkerFactory` 参照)。
 */
class FakeWorker implements WorkerLike {
  readonly sent: EngineRequestMessage[] = [];
  private listener: ((event: MessageEvent) => void) | undefined;
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message as EngineRequestMessage);
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

  emit(data: EngineResponseMessage): void {
    this.listener?.({ data } as MessageEvent);
  }
}

/**
 * Worker生成回数を数えつつ、常に同じ `FakeWorker` を返すファクトリを作る。
 * `getSharedEngineClient` はキャッシュ済みインスタンスがあれば `createWorker` を
 * そもそも呼ばない(=このファクトリが複数回呼ばれないこと自体が「新規Workerが
 * 生成されていない」ことの証拠になる)。
 */
function createCountingWorkerFactory(): { createWorker: () => WorkerLike; worker: FakeWorker; callCount: () => number } {
  const worker = new FakeWorker();
  let calls = 0;
  return {
    createWorker: () => {
      calls += 1;
      return worker;
    },
    worker,
    callCount: () => calls,
  };
}

const board = { black: 0x0000000810000000n, white: 0x0000001008000000n };
const limit = { depth: 6, exactFromEmpties: 24 };

describe('getSharedEngineClient (T054)', () => {
  afterEach(() => {
    // 各テスト後にキャッシュをリセットし、テスト間で共有インスタンスが
    // 漏れないようにする(実アプリでは通常リセットしない)。
    resetSharedEngineClientForTest();
  });

  it('creates the underlying worker only once no matter how many times it is called', () => {
    const { createWorker, callCount } = createCountingWorkerFactory();

    // モード切替を模して、複数の「モードコンポーネント」がそれぞれ独立に
    // getSharedEngineClient を呼ぶ状況をシミュレートする
    // (例: 定石練習→中盤練習→対局、のように行き来する)。
    const fromJoseki = getSharedEngineClient(createWorker);
    const fromMidgame = getSharedEngineClient(createWorker);
    const fromPlay = getSharedEngineClient(createWorker);
    const fromTsume = getSharedEngineClient(createWorker);
    const fromAnalysis = getSharedEngineClient(createWorker);

    expect(callCount()).toBe(1);
    expect(fromJoseki).toBe(fromMidgame);
    expect(fromMidgame).toBe(fromPlay);
    expect(fromPlay).toBe(fromTsume);
    expect(fromTsume).toBe(fromAnalysis);
  });

  it('keeps the same instance even when called again with a different factory (factory is ignored once cached)', () => {
    const first = createCountingWorkerFactory();
    const second = createCountingWorkerFactory();

    const client1 = getSharedEngineClient(first.createWorker);
    const client2 = getSharedEngineClient(second.createWorker);

    expect(client1).toBe(client2);
    expect(first.callCount()).toBe(1);
    expect(second.callCount()).toBe(0);
  });

  it('dispatches concurrent requests issued from different "mode" call sites to the correct promise via the existing request-id scheme', async () => {
    const { createWorker, worker } = createCountingWorkerFactory();

    // 「定石練習モード」「中盤練習モード」がそれぞれ自分のタイミングで
    // getSharedEngineClient() を呼び、同じ共有インスタンスに対して
    // 同時にリクエストを投げても、リクエストIDで正しく解決されることを確認する。
    const josekiEngine = getSharedEngineClient(createWorker);
    const midgameEngine = getSharedEngineClient(createWorker);

    const fromJoseki = josekiEngine.requestAnalyze(board, 'black', limit);
    const fromMidgame = midgameEngine.requestAnalyzeAll(board, 'white', limit);

    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[0]?.id).toBe(1);
    expect(worker.sent[1]?.id).toBe(2);

    // レスポンスが送信順と逆に届いても正しいPromiseに解決されること。
    worker.emit({
      id: 2,
      final: true,
      depth: 5,
      pv: ['c4'],
      score: { type: 'midgame', discDiff: 1 },
      nodes: 20,
      nps: 2000,
      moves: [{ move: 'c4', score: 100, discDiff: 1, type: 'midgame' }],
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

    await expect(fromJoseki).resolves.toMatchObject({ id: 1, pv: ['d3'] });
    await expect(fromMidgame).resolves.toEqual([{ move: 'c4', score: 100, discDiff: 1, type: 'midgame' }]);
  });

  it('terminateSharedEngineClient terminates the worker and clears the cache so the next call creates a new one', () => {
    const first = createCountingWorkerFactory();
    const client1 = getSharedEngineClient(first.createWorker);
    expect(first.callCount()).toBe(1);

    terminateSharedEngineClient();
    expect(first.worker.terminated).toBe(true);

    const second = createCountingWorkerFactory();
    const client2 = getSharedEngineClient(second.createWorker);

    expect(client2).not.toBe(client1);
    expect(second.callCount()).toBe(1);
  });
});
