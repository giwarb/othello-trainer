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

// T171: V3+corner5x2(D1候補、T168で追加したcorner 2x5ブロックパターンを
// モビリティ・囲い度スカラー特徴と組み合わせた46インスタンス/11クラス、
// PWV6形式)を採用。T169の対Edaxゲートで現行v5に対して+4.53石
// (opening平均、95%CI[1.78,7.33]、sign-test p=0.043)の有意改善を確認し、
// ユーザーがサイズ増(gzip約5.9MB→10.7MB、+82%)を了承のうえ採用裁定
// (2026-07-21)。`train/data/t168/d1/t168-d1-canonical-seed-1-earlystop.bin`
// (SHA-256 e69f3b1c...、`bench/edax-compare/t168_training_report.meta.json`
// のt169Manifest参照)を`train/weights/pattern_v6.bin`・
// `app/public/pattern_v6.bin`にコピーした
// もの。`public/joseki.json`と同様に静的アセットとして配置し、
// `import.meta.env.BASE_URL`(GitHub Pagesのサブパス配信 `vite.config.ts` 参照)
// を前置してfetchする。
//
// **切り戻し手順(v5へ戻す場合)**: 以下の2点を**両方セットで**行うこと。
// 片方だけでは古い解析結果が誤って使い回される事故になる(T122申し送り
// 事項、片方だけの変更で発生した実際の不具合が教訓)。
//   1. 下記URLのファイル名を`pattern_v5.bin`へ戻す(既存ファイルは削除せず
//      残してあるので、このファイルを指すだけでよい)。
//   2. `analysis/cache.ts`の`ANALYSIS_ENGINE_VERSION`を**必ずもう1つ
//      繰り上げる**(現在8から戻すなら9。**7に戻すのではなく、常に直近の
//      最大値+1へ進めること**。バージョン番号は往復させず単調増加させる
//      運用のため、切り戻しであっても新しい番号を割り当てる)。
// (T122申し送り事項の解消: 従来のコメントは「ファイル名を戻すだけでよい」
// という記述が先にあり、版数繰り上げの必須性が読み手に伝わりにくかった。
// 本コメントでは切り戻し手順そのものに版数繰り上げを明記する。詳細は
// `cache.ts`のT060コメント参照)。
//
// v5以前(v2/v3/v4)や将来のcanonical再学習版へ切り替える場合も同様に、
// ファイル名変更とANALYSIS_ENGINE_VERSIONの繰り上げを必ずセットで行う。
const PATTERN_WEIGHTS_URL = `${import.meta.env.BASE_URL}pattern_v6.bin`;

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
