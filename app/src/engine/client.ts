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
  ErrorResponseMessage,
  EvalTermsRequestMessage,
  EvalTermsResponseMessage,
  FeatureSetRequestMessage,
  FeatureSetResponseMessage,
  MoveEvalJson,
  Side,
} from './types';
import { isErrorResponse } from './types';

/** `EngineResponseMessage` からエラー応答を除いた、正常応答のみの型。 */
type SuccessResponse = Exclude<EngineResponseMessage, ErrorResponseMessage>;

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
  resolve: (response: SuccessResponse) => void;
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
      this.pending.set(id, { resolve: (response) => resolve(response as AnalyzeResponseMessage), reject });
      this.worker.postMessage(message);
    });
  }

  /**
   * 盤面・手番・探索条件を指定して、現局面の**全合法手**の評価値をまとめて
   * リクエストする(T018)。悪手判定(打った手が最善手からどれだけ悪いか)・
   * 定石外判定など、モード共通の解析基盤として使う。
   *
   * 内部的には `requestAnalyze` と同じ `cmd: 'analyze'` に
   * `allMoves: true` を付けて送るだけであり、リクエストID管理・
   * エラー処理は共通(`handleMessage`)。レスポンスの `moves` フィールド
   * (存在しない場合は空配列)を取り出して返す。
   */
  requestAnalyzeAll(board: Board, turn: Side, limit: AnalyzeLimit): Promise<MoveEvalJson[]> {
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
      allMoves: true,
    };

    return new Promise<MoveEvalJson[]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) => resolve((response as AnalyzeResponseMessage).moves ?? []),
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  /**
   * T031: 現行評価関数(`eval.rs`)の3項(モビリティ差・隅差・安定石差)の
   * 生の特徴量差分を1局面ぶんリクエストする。`app/src/analysis/attribution.ts`の
   * `buildAttribution`(純粋関数)に渡し、2局面間の評価差の内訳(waterfall分解)
   * を構築するために使う。探索を伴わないため`limit`は不要。
   */
  requestEvalTerms(board: Board, turn: Side): Promise<EvalTermsResponseMessage> {
    const id = this.nextRequestId++;
    const message: EvalTermsRequestMessage = {
      id,
      cmd: 'evalTerms',
      board: {
        black: bigintToHex(board.black),
        white: bigintToHex(board.white),
        turn,
      },
    };

    return new Promise<EvalTermsResponseMessage>((resolve, reject) => {
      this.pending.set(id, { resolve: (response) => resolve(response as EvalTermsResponseMessage), reject });
      this.worker.postMessage(message);
    });
  }

  /**
   * T031: 設計書§1「特徴量層」の12特徴量のうちRust側(`engine/src/explain.rs`)
   * で計算する11個(余裕手を除く)を、ある局面である1手についてリクエストする。
   * 本タスク時点ではUIには未統合(将来のモチーフ検出・言語化テンプレート生成
   * タスクからの利用を見込んだAPI)。`move`は`turn`にとって合法手である必要がある。
   */
  requestFeatureSet(board: Board, turn: Side, move: string): Promise<FeatureSetResponseMessage> {
    const id = this.nextRequestId++;
    const message: FeatureSetRequestMessage = {
      id,
      cmd: 'featureSet',
      board: {
        black: bigintToHex(board.black),
        white: bigintToHex(board.white),
        turn,
      },
      move,
    };

    return new Promise<FeatureSetResponseMessage>((resolve, reject) => {
      this.pending.set(id, { resolve: (response) => resolve(response as FeatureSetResponseMessage), reject });
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
