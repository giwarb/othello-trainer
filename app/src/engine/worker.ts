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

// T147: WTHOR学習済みパターン評価v4(ステージ1石刻み61段、T124で導入・
// T125のseed3を採用、`train/weights/pattern_v4.bin`を`app/public/pattern_v4.bin`
// にコピーしたもの)。`public/joseki.json`と同様に静的アセットとして配置し、
// `import.meta.env.BASE_URL`(GitHub Pagesのサブパス配信 `vite.config.ts` 参照)
// を前置してfetchする。
// v3へ切り戻す場合は、ファイル名を`pattern_v3.bin`へ戻すだけでよい(T122参照)。
// **ただし、ここを変更する(v3/v4を切り替える)たびに、
// `analysis/cache.ts`の`ANALYSIS_ENGINE_VERSION`も必ず1つ上げること**
// (T122申し送り事項、T139で追記。評価値が変わるのにキャッシュキーが
// 変わらないと、古いバージョンで解析した結果がヒットし続け、新しい重みでの
// 再解析が行われない。詳細は`cache.ts`のT060コメント参照)。
const PATTERN_WEIGHTS_URL = `${import.meta.env.BASE_URL}pattern_v4.bin`;

/**
 * 本番用パターン重みをfetchして `engine.load_pattern_weights` に渡す。
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
      throw new Error(`failed to fetch ${PATTERN_WEIGHTS_URL}: ${response.status}`);
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
