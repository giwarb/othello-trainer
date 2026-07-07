// Web Workerのエントリポイント。
// wasm-bindgen生成の `Engine` を初期化し、Worker終了までインスタンスを1つ
// 保持し続ける(T007の置換表(TT)再利用の恩恵を受けるため)。
// UIスレッドからの `postMessage` を受け取り、`engine.analyze()` の結果を
// `postMessage` で返す。
//
// 注意: `./pkg` はビルド時に `wasm-pack build --target web` で生成される
// ディレクトリ(.gitignore対象)。`npm run dev` / `npm run build` の前に
// `build-wasm.mjs` が自動実行され生成される想定(`../../package.json` 参照)。
import init, { Engine } from './pkg/engine.js';
import type { AnalyzeRequestMessage, EngineResponseMessage } from './types';

// Worker内のグローバルスコープ。`tsconfig.app.json` は `lib: ["ES2023", "DOM"]`
// を使っており(メインスレッド用の型)、Worker専用の `lib: "webworker"` を
// 追加すると同一プログラム内で `Window`/`DedicatedWorkerGlobalScope` の型が
// 衝突するため、Workerとのやり取りに必要な最小限のインターフェースだけを
// 明示してキャストする。
interface DedicatedWorkerScope {
  onmessage: ((event: MessageEvent<AnalyzeRequestMessage>) => void) | null;
  postMessage(message: EngineResponseMessage): void;
}

const workerScope = self as unknown as DedicatedWorkerScope;

let engine: Engine | undefined;
let readyPromise: Promise<void> | undefined;

/** WASMモジュールの初期化と `Engine` インスタンスの生成を1回だけ行う。 */
function ensureEngineReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().then(() => {
      engine = new Engine();
    });
  }
  return readyPromise;
}

workerScope.onmessage = (event: MessageEvent<AnalyzeRequestMessage>): void => {
  const request = event.data;
  void ensureEngineReady().then(() => {
    if (!engine) {
      return;
    }
    const responseJson = engine.analyze(JSON.stringify(request));
    const response = JSON.parse(responseJson) as EngineResponseMessage;
    workerScope.postMessage(response);
  });
};
