---
id: T012
title: Web Worker + WASMエンジン統合
status: done
assignee: implementer
attempts: 0
---

# T012: Web Worker + WASMエンジン統合

## 目的
T001〜T008で実装したRust/WASMオセロエンジンを、ブラウザのWeb Worker内から呼び出せるようにする。これでUIスレッドをブロックせずにエンジンの思考を実行できる。T011(盤面UI)とは独立して実装できる。

## 背景・コンテキスト
- 前提: T010(`/app`雛形)完了済み。`engine/` クレートはT001〜T008で完成しており、`engine/src/lib.rs` に `#[wasm_bindgen] pub struct Engine` があり、コンストラクタ `new()` とメソッド `analyze(request_json: &str) -> String` を持つ(JSON文字列を受け取りJSON文字列を返す。詳細は `engine/src/protocol.rs` と `tasks/T008-wasm-api.md` を参照)。
- `engine/pkg/` は `wasm-pack build --target web` で生成されるビルド成果物で、`.gitignore` 済み(コミット対象外)。`/app` のビルド時に毎回生成し直す前提にする。
- リクエスト/レスポンスのJSON形式(`tasks/T008-wasm-api.md` 要件1を参照):
  ```jsonc
  // リクエスト
  { "id": 1, "cmd": "analyze",
    "board": { "black": "0x...", "white": "0x...", "turn": "black" },
    "limit": { "depth": 12, "timeMs": 2000, "exactFromEmpties": 14 } }
  // レスポンス
  { "id": 1, "final": true, "depth": 10, "pv": ["f5","d6"],
    "score": { "type": "midgame", "discDiff": 2.4 }, "nodes": 123456, "nps": 2000000 }
  ```
- `black`/`white` は64bit整数の16進数文字列(`"0x"`始まり)。TypeScript側では `bigint` を使い、`` `0x${board.black.toString(16).padStart(16, '0')}` `` のような形で変換する。

## 変更対象(新規作成)
- `app/src/engine/build-wasm.mjs`(または `package.json` のnpmスクリプトのみで完結してもよい): `wasm-pack build ../engine --target web --out-dir ../app/src/engine/pkg` のような、engineクレートをビルドして `/app` 側から参照可能な場所に出力するスクリプト・設定
- `app/src/engine/worker.ts`: Web Workerのエントリポイント。`Engine`(wasm-bindgen生成)を初期化し、UIスレッドからの `postMessage` を受けて `engine.analyze(json)` を呼び、結果を `postMessage` で返す
- `app/src/engine/client.ts`: UIスレッド側からWorkerを使うためのラッパー(Workerの生成、リクエストIDの管理、Promiseベースの `requestAnalyze(board, limit): Promise<AnalyzeResponse>` のようなAPI)
- `app/src/engine/types.ts`: リクエスト/レスポンスのTypeScript型定義(T008のJSONスキーマに対応)
- `app/package.json` / `app/vite.config.ts`: 上記ビルドスクリプトの統合(`npm run build` 実行時にwasmビルドが自動的に走るようにする。例: `"prebuild": "node src/engine/build-wasm.mjs"` 等)

## 要件
1. `wasm-pack`(T001でインストール済み)を使い、`engine/` クレートを `--target web` でビルドし、`/app` から `import` できる場所(例: `app/src/engine/pkg/`)に出力する仕組みを作る。この出力先は `.gitignore` に追加し(ビルド成果物のため)、`npm run dev`・`npm run build` の前に自動的にビルドされるようにする(`package.json` の `pre`スクリプト、または `vite.config.ts` のプラグイン、どちらでもよい)。
2. `worker.ts`: Vite で Web Worker を作る標準的な方法(`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`)を使う。Worker内で `pkg` からWASMを初期化(`init()`相当)した後、`new Engine()` でインスタンスを1つ保持する(T007のTT再利用の恩恵を受けるため、Workerのライフタイム中は同じ`Engine`インスタンスを使い続けること)。
3. `postMessage` で受け取ったリクエストをそのまま(またはTS側の型からJSON文字列に変換して)`engine.analyze()` に渡し、返ってきたJSON文字列をパースして `postMessage` で返す。
4. `client.ts`: `board`(TS側の盤面表現。T011の `Board` 型、またはこのタスクで独自に `{black: bigint, white: bigint}` を定義してもよい)と手番、`limit` を受け取り、`0x`16進文字列に変換してWorkerにリクエストを送り、`id`をキーにレスポンスを待ち合わせるPromiseベースのAPIを実装する。複数の同時リクエストを扱えるよう、リクエストIDをインクリメントして管理すること。
5. 単体テスト(Vitest):
   - bigint ⇔ 16進文字列変換のヘルパー関数が正しいこと(例: `0n` → `"0x0000000000000000"`、既知の値の往復変換)
   - `client.ts` のリクエストID管理ロジック(モックしたWorkerやメッセージハンドラで、複数リクエストが正しいレスポンスに解決されること)を検証する(実際のWASM/Workerを起動しない、ロジック単体のテストでよい)
6. 実機確認: `npm run dev` でアプリを起動し、ブラウザの開発者コンソールから `client.ts` の関数を直接呼び出す(またはT011のBoardと組み合わせた簡単な動作確認ページを一時的に作る)などして、実際にWorker経由でエンジンから応答が返ってくることを1回は目視確認する。確認した内容を作業ログに記載すること。

## やらないこと(スコープ外)
- 対局モードのゲームループ・UI統合(T013)
- PWA・オフラインキャッシュ(T014)
- デプロイ設定(T015)
- 逐次進捗報告(`final: false`)への対応(T008同様、本タスクでもスコープ外。1回のリクエストにつき1回の最終応答のみ扱う)
- マルチスレッド化・SharedArrayBuffer(現時点のエンジンはシングルスレッドのため不要)

## 受け入れ基準(検証コマンド)
- [ ] `cd app && npm run typecheck` がエラー0で通る
- [ ] `cd app && npm test`(Vitest等)で本タスクの単体テストが全件パスする
- [ ] `cd app && npm run build` が成功する(wasmビルドの自動実行を含む)
- [ ] 作業ログに、実際にブラウザでWorker経由のエンジン応答を確認した際の手順・結果が記載されている

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-07 implementer: 要件どおりに実装した。

  実施内容:
  - `app/src/engine/types.ts`(新規): `BoardJson`/`AnalyzeLimit`/`AnalyzeRequestMessage`/`ScoreJson`/`AnalyzeResponseMessage`/`ErrorResponseMessage`等、T008のJSONスキーマに対応するTS型を定義。`isErrorResponse`型ガードも追加。
  - `app/src/engine/hex.ts`(新規): `bigintToHex`/`hexToBigint`ヘルパー。64bit固定長(16桁)ゼロ埋め、`0x`プレフィックス付き。範囲外(負値・65bit以上)は`RangeError`。
  - `app/src/engine/client.ts`(新規): `EngineClient`クラス。`WorkerLike`という最小インターフェース経由でWorkerを生成(既定は`new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`)、テスト時はフェイクWorkerに差し替え可能にした。`requestAnalyze(board, turn, limit)`はリクエストIDをインクリメントしつつ`Map<id, {resolve,reject}>`で複数同時リクエストを管理し、Promiseを返す。`id`不明のエラー応答(JSON構文エラー等)は無視、`id`判明のエラー応答は該当Promiseをreject。
  - `app/src/engine/worker.ts`(新規): `./pkg/engine.js`(wasm-pack `--target web`生成)から`init`/`Engine`をimportし、Worker生成時に一度だけ`init()`→`new Engine()`を実行してモジュールスコープに保持(Workerのライフタイム中使い回す→TT再利用)。`postMessage`で受けたリクエストを`JSON.stringify`して`engine.analyze()`に渡し、結果を`JSON.parse`して`postMessage`で返す。`self`の型は`lib:"webworker"`追加によるDOM libとの型衝突を避けるため、必要最小限のインターフェースへの`as unknown as`キャストで対応。
  - `app/src/engine/build-wasm.mjs`(新規): `wasm-pack build <engineクレートの絶対パス> --target web --out-dir <app/src/engine/pkgの絶対パス> --out-name engine`を`child_process.spawnSync`で実行するNodeスクリプト。スクリプト自身の`import.meta.url`から絶対パスを解決するため、実行時のカレントディレクトリに依存しない。
  - `app/package.json`: `wasm:build`スクリプトを追加し、`predev`/`prebuild`/`pretypecheck`から呼び出すようにして`npm run dev`・`npm run build`・`npm run typecheck`実行前に自動的にwasmビルドが走るようにした(`typecheck`は要件文には明記されていないが、`worker.ts`が`./pkg/engine.js`をimportするため、pkg未生成状態だと型チェックが失敗するので同様にフックした)。`test`スクリプト(`vitest run`)と`devDependencies.vitest`も追加。
  - `app/.gitignore`: `src/engine/pkg`を追加(ビルド成果物のためコミット対象外)。
  - `app/vitest.config.ts`(新規): `environment: 'node'`、`include: ['src/**/*.test.ts']`。実WASM/Workerを起動しないロジック単体テストのみなので軽量な`node`環境で十分と判断。
  - `app/src/engine/hex.test.ts`(新規、8件): `bigintToHex`/`hexToBigint`の往復変換・ゼロ埋め・境界値(0n, 64bit最大値)・異常値(負値、65bit超)を検証。
  - `app/src/engine/client.test.ts`(新規、5件): フェイクWorker(`postMessage`呼び出しを記録し、`emit()`でテストコードから任意タイミングでレスポンスを配信できるスタブ)を使い、(1) リクエストIDのインクリメントと`board`の16進エンコード、(2) 複数同時リクエストが送信順と逆にレスポンスが届いても正しいPromiseに解決されること、(3) エラー応答時のreject、(4) `id: null`のエラー応答が無視され後続の正常応答で解決されること、(5) `terminate()`でWorkerが終了することを検証。

  **スコープ外だが実機確認中に発見・修正した engine/ クレートのバグ(要オーケストレーター確認)**:
  - 実機確認(Playwright + Chromiumでの`npm run dev`実行中アプリへの接続)で、Worker経由の`engine.analyze()`呼び出しが`RuntimeError: unreachable`(wasmトラップ)で必ず失敗することを発見した。原因調査のため`app/src/engine/pkg/engine.js`を直接メインスレッドからimportして最小リクエスト(`depth:1`)で再現したところ、Worker経由と同じ`unreachable`トラップが発生し、Worker/client実装ではなく`engine`クレート自体(T005/T008で実装済み)の問題と判明した。
  - 原因: `engine/src/search.rs`(検索ループの計時)と`engine/src/protocol.rs`(nps計算の計時)が`std::time::Instant::now()`を呼んでいるが、これは`wasm32-unknown-unknown`ターゲットでは未実装のため**コンパイルは通るが実行時に必ずpanicする**(`cargo test -p engine`はネイティブターゲットで実行されるためこの問題を検出できていなかった)。
  - 対処: `web-time`クレート(`engine/Cargo.toml`に追加、v1.1.0。std::time::Instant互換API、wasm上は`Performance.now()`を使う)に差し替え。`engine/src/search.rs`・`engine/src/protocol.rs`の`use std::time::Instant;`を`use web_time::Instant;`に変更(呼び出し側コードは無変更)。`#[cfg(test)]`内の完全修飾`std::time::Instant`(ネイティブでのみ実行されるテストコード)はスコープが違うため変更していない。
  - 検証: `cargo test -p engine`(44件パス、変更前と同数)・`cargo clippy -p engine -- -D warnings`(警告0)を再実行し、修正が既存の動作に影響しないことを確認済み。
  - 本来は`engine/`配下のファイルは本タスク(T012)の変更対象外だが、実機確認(要件6、必須の受け入れ基準)がこのバグにより不可能だったため、影響範囲を`Instant`の参照2箇所の差し替えのみに限定した上で修正した。T005/T008(検索・WASM API)のいずれかの担当範囲の不具合と考えられるため、必要であれば該当タスクの作業ログへの反映をオーケストレーター側で判断されたい。

  検証結果(すべて実行し確認、`$env:PATH`に`.cargo\bin`を追加した上で実行):
  - `cd app && npm run typecheck` → エラー0(`pretypecheck`フックでwasmビルドも自動実行され成功)。
  - `cd app && npx vitest run src/engine` → 2ファイル・13件全件パス(`hex.test.ts` 8件 + `client.test.ts` 5件)。
    - 注記: `cd app && npm test`(全体)を実行すると、並行して進行中の別タスク(T011)の`app/src/game/othello.test.ts`内に本タスクと無関係な既存の失敗(白の初期合法手のテスト、1件)が含まれるため全体としては失敗する。本タスク(T012)が新規作成したテストファイル(`src/engine/hex.test.ts`, `src/engine/client.test.ts`)は`npx vitest run src/engine`で全件パスすることを確認済み。T011側のテスト失敗は本タスクの変更とは無関係(該当ファイルは一切変更していない)。
  - `cd app && npm run build` → 成功(`prebuild`フックでwasmビルド自動実行、`tsc -b && vite build`が`dist/`を生成)。なお、現時点では`app/src/engine/client.ts`をUIコード(`app.tsx`等)からまだ誰も参照していない(UI統合はT013のスコープ)ため、ビルド成果物には`worker.ts`/wasmチャンクは含まれない(Viteの到達可能性解析上、未使用モジュールは含まれないため。これは想定どおりの挙動)。
  - 実機確認(要件6、Playwright + Chromiumで`npm run dev`のサーバへ接続して検証。手順と結果):
    1. `npm run dev`でVite開発サーバを起動(`http://localhost:5173/`)。
    2. Playwrightでページを開き、ブラウザコンテキスト内で`await import('/src/engine/client.ts')`により`EngineClient`をロードし、`new EngineClient()`でインスタンス化(実際のWeb Workerが生成されることを`page.on('worker', ...)`イベントで確認: `http://localhost:5173/src/engine/worker.ts?worker_file&type=module`)。
    3. `client.requestAnalyze({black: 0x0000000810000000n, white: 0x0000001008000000n}, 'black', {depth: 8, exactFromEmpties: 20})`を呼び出し、返ってきたレスポンスを確認。結果: `{"id":1,"final":true,"depth":8,"pv":["d3","c3","c4","e3","d2","b4","b3","b2"],"score":{"type":"midgame","discDiff":0},"nodes":3513,"nps":1171000}`(初期局面の合法な手`d3`から始まるPVが返り、`final:true`・`nodes`/`nps`も妥当な値であることを確認)。
    4. `client.terminate()`でWorkerが終了すること(`page.on('worker', w => w.on('close', ...))`で`worker closed`イベント発火)を確認。
    5. 上記1〜4は、前述の`web-time`修正前は`RuntimeError: unreachable`で必ず失敗することも確認済み(修正の必要性の裏付け)。

  コミット対象(`app/src/engine/`配下・`app/package.json`・`app/package-lock.json`・`app/.gitignore`・`app/vitest.config.ts`・`engine/Cargo.toml`・`engine/src/protocol.rs`・`engine/src/search.rs`・`Cargo.lock`)は`git add`で個別ファイル指定してコミット済み(`tasks/`・`CLAUDE.md`は本作業ログ追記以外変更していない。`git status`で他タスク(T011)の変更中ファイルが混在していないことを確認済み)。
