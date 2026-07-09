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
import type { EngineRequestMessage, EngineResponseMessage } from './types';

// Worker内のグローバルスコープ。`tsconfig.app.json` は `lib: ["ES2023", "DOM"]`
// を使っており(メインスレッド用の型)、Worker専用の `lib: "webworker"` を
// 追加すると同一プログラム内で `Window`/`DedicatedWorkerGlobalScope` の型が
// 衝突するため、Workerとのやり取りに必要な最小限のインターフェースだけを
// 明示してキャストする。
interface DedicatedWorkerScope {
  onmessage: ((event: MessageEvent<EngineRequestMessage>) => void) | null;
  postMessage(message: EngineResponseMessage): void;
}

const workerScope = self as unknown as DedicatedWorkerScope;

let engine: Engine | undefined;
let readyPromise: Promise<void> | undefined;

// T045: WTHOR学習済みパターン評価v2(`train/weights/pattern_v2.bin`を
// `app/public/pattern_v2.bin`にコピーしたもの)。`public/joseki.json`と同様に
// 静的アセットとして配置し、`import.meta.env.BASE_URL`(GitHub Pagesの
// サブパス配信 `vite.config.ts` 参照)を前置してfetchする。
const PATTERN_WEIGHTS_URL = `${import.meta.env.BASE_URL}pattern_v2.bin`;

/**
 * `pattern_v2.bin` をfetchして `engine.load_pattern_weights` に渡す。
 *
 * fetch失敗(オフライン・404等)・パース失敗のいずれも `console.error` の
 * みで飲み込み、例外を外に伝播させない。これにより`Engine`は従来の3項
 * ヒューリスティック評価で動作を続ける(`josekiDb: null` と同じ、
 * グレースフルフォールバックの考え方。`tasks/T045-pattern-eval-wasm-wiring.md`
 * 参照)。
 */
async function loadPatternWeights(target: Engine): Promise<void> {
  try {
    const response = await fetch(PATTERN_WEIGHTS_URL);
    if (!response.ok) {
      throw new Error(`failed to fetch pattern_v2.bin: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    target.load_pattern_weights(bytes);
  } catch (error) {
    console.error('[worker] failed to load pattern weights, falling back to heuristic eval:', error);
  }
}

/** WASMモジュールの初期化と `Engine` インスタンスの生成を1回だけ行う。 */
function ensureEngineReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().then(async () => {
      engine = new Engine();
      await loadPatternWeights(engine);
    });
  }
  return readyPromise;
}

workerScope.onmessage = (event: MessageEvent<EngineRequestMessage>): void => {
  const request = event.data;
  void ensureEngineReady().then(() => {
    if (!engine) {
      return;
    }
    // `cmd: 'analyze'` は既存の`Engine::analyze`(探索・置換表を使う)、
    // それ以外(T031で追加した`'evalTerms'`/`'featureSet'`)は
    // `Engine::explain`(探索を伴わない特徴量計算)に振り分ける。
    const responseJson =
      request.cmd === 'analyze' ? engine.analyze(JSON.stringify(request)) : engine.explain(JSON.stringify(request));
    const response = JSON.parse(responseJson) as EngineResponseMessage;
    workerScope.postMessage(response);
  });
};
