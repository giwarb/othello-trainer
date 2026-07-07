// UIスレッド側からWeb Worker上のWASMエンジンを利用するためのラッパー。
// Workerの生成・リクエストIDの管理・PromiseベースのAPIを提供する。
// 参照: tasks/T012-worker-engine.md

import { bigintToHex } from './hex';
import type {
  AnalyzeLimit,
  AnalyzeRequestMessage,
  AnalyzeResponseMessage,
  Board,
  EngineResponseMessage,
  Side,
} from './types';
import { isErrorResponse } from './types';

/**
 * `Worker` のうち本クライアントが実際に使用する最小限のインターフェース。
 * 単体テストでは実際の `Worker`/WASMを起動せず、このインターフェースを満たす
 * フェイクオブジェクトに差し替えてリクエストID管理ロジックのみを検証する。
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** 本番環境で使う実際のWorkerを生成する(Viteの標準的なWorker生成方法)。 */
function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

interface PendingRequest {
  resolve: (response: AnalyzeResponseMessage) => void;
  reject: (error: Error) => void;
}

/**
 * Web Worker上のWASMエンジンを呼び出すクライアント。
 * インスタンスごとに1つのWorkerを保持し、Workerのライフタイム中
 * 同じ`Engine`インスタンス(WASM側でTTを保持)を使い続ける。
 */
export class EngineClient {
  private readonly worker: WorkerLike;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handleMessage = (event: MessageEvent<EngineResponseMessage>): void => {
    const message = event.data;
    if (message.id == null) {
      // JSON構文エラー等でリクエストIDすら分からないエラー応答は、
      // どのPromiseにも対応付けられないため無視する。
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    this.pending.delete(message.id);
    if (isErrorResponse(message)) {
      request.reject(new Error(message.error));
    } else {
      request.resolve(message);
    }
  };

  constructor(createWorker: () => WorkerLike = createDefaultWorker) {
    this.worker = createWorker();
    this.worker.addEventListener('message', this.handleMessage);
  }

  /**
   * 盤面・手番・探索条件を指定してエンジンに解析をリクエストする。
   * リクエストIDは呼び出しごとにインクリメントして発行するため、
   * 複数の同時リクエストを送っても、それぞれ正しいレスポンスに解決される。
   */
  requestAnalyze(board: Board, turn: Side, limit: AnalyzeLimit): Promise<AnalyzeResponseMessage> {
    const id = this.nextRequestId++;
    const message: AnalyzeRequestMessage = {
      id,
      cmd: 'analyze',
      board: {
        black: bigintToHex(board.black),
        white: bigintToHex(board.white),
        turn,
      },
      limit,
    };

    return new Promise<AnalyzeResponseMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  /** Workerを終了する。以後このクライアントで新規リクエストは送れない。 */
  terminate(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
    this.pending.clear();
  }
}
