---
id: T122
title: v3×WTHOR重みの本番配線(評価関数の世代交代)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T122: v3×WTHOR重みの本番配線

## 目的

T121で最終審査に合格した **v3×WTHOR重み**(`train/data/t087/v3-seed-3.bin`、PWV3形式、SHA-256 `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`)を本番アプリの評価関数として配線し、GitHub Pagesに公開する。オーケストレーター採用裁定(2026-07-17、T121の判定材料: oracle regret 1.400 vs v2 1.567、対Edax60局 -21.23 vs -21.85、NPS 93.7%、回帰ゼロ)。

## 背景・前提

- v3特徴・PWV3形式のエンジン側基盤はT087で実装・コミット済み(eval_cli等はpattern-set選択に対応済み=T110)。**WASM経路(app→worker→engine)がPWV3ロードに対応しているかは要確認** — 未対応ならエンジン/プロトコルの必要最小限の拡張を行う。
- 現行の重み配信: v2重み(`pattern_v2.bin`相当)がアプリ資産としてどう配布・ロードされているか(app/public/? Cache Storageのキャッシュ? Service Workerのバージョニング?)を調査し、**同じ機構でv3を配信**する。v3重みは5,964,708 bytes(v2とサイズ比較を作業ログに記録)。
- **ロールバック容易性**: v2重みと切替機構は残す(即時に戻せる形。UIトグルは不要、コード上の定数/設定切替でよい)。

## 要件

1. **配線**: 本番アプリ(対局CPU・解析・詰めオセロ等、評価関数を使う全経路)の重みをv3に切り替える。重みファイルの配置はリポジトリの既存流儀に従う(巨大バイナリの扱い: v2が既にリポジトリ/配信に含まれる流儀をそのまま踏襲。Git LFS等の新機構は導入しない)。
2. **キャッシュ整合**:
   - `ANALYSIS_ENGINE_VERSION` を3→**4**にインクリメント(評価値が変わるため解析キャッシュ無効化が必須)。
   - **ついで対応(T107申し送り)**: `app/src/analysis/cache.ts` のANALYSIS_ENGINE_VERSION=3時に追記されたコメントの根拠が不正確(解析経路はquota非依存)なので、今回の変更にあわせて正しい説明に修正。
   - Service Worker / Cache Storageの重みキャッシュが更新されること(バージョン繰り上げ等、既存機構の流儀)を確認。
3. **検証**:
   - エンジン単体: v3ロード後のeval値がeval_cli(--pattern-weights v3)と一致するサンプル検証。FFO #40-44正解値不変。`cargo test -p engine` 全件パス。
   - app: `npm test -- --run` グリーン、`npx tsc --noEmit` エラーなし。既存テストが重みに依存している箇所の追従。
   - 本番: push→Actions成功→**Pages実機で対局・解析・詰めオセロが正常動作**し、評価値が表示されること(Playwright推奨)。重みの取得(ネットワークタブ相当でv3ファイルの200)を確認。
4. **決定性**: 同一局面での再現一致(サンプル)。
5. 変更対象ファイルのみパス指定でコミット(`(T122)`)。tasks/とCLAUDE.mdはコミットしない。

## やらないこと(スコープ外)

- 評価関数のさらなる学習・調整
- UIでの重み切替機能
- 定石DB・終盤ソルバーの変更

## 受け入れ基準(検証コマンド)

- [ ] 本番Pagesの対局CPU(強)・解析・評価バーがv3重みで動作している(実機確認の証跡)
- [ ] `ANALYSIS_ENGINE_VERSION`=4、cache.tsコメント修正済み
- [ ] eval_cli(v3指定)とWASM経路の評価値一致サンプル、FFO不変、決定性一致の記録
- [ ] `cargo test -p engine`+`npm test -- --run`+`npx tsc --noEmit` 全グリーン
- [ ] v2への切り戻し手順(1〜2行の変更で戻せること)が作業ログに記録されている
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認済み
- [ ] 変更対象ファイルのみパス指定でコミット(`(T122)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 オーケストレーター注記: codex-reviewブロッカーの解消(verifier実機確認完了)

codex-review(初回)の唯一の重大指摘「Pages実機確認とActions成功確認が未完了」は、verifierが独立実施し**全項目合格**で解消済み: Actions両run success(29550780147/29550780149)、Pagesで対局CPU強・評価バー・候補手評価・詰めオセロ・棋譜解析の実機動作、pattern_v3.bin fetch 200(解凍後5,964,708 bytes一致)、コンソールエラー0、3配置のSHA-256完全一致、git statusクリーン。証跡スクリーンショットはverifierレポート参照。

中・軽微指摘の扱い(申し送り): (中)worker.tsのロールバックコメントがANALYSIS_ENGINE_VERSION繰り上げに言及しておらず、コメントだけ見て戻すと解析キャッシュ混在を招く / (軽微)train/weights/README.mdに旧説明の残存 — いずれも挙動に影響しないため、次にworker.ts/READMEを触るタスクで修正(STATUS申し送りに記録)。

## 作業ログ(担当エージェントが追記)

### 2026-07-17 11:46 JST — Codex実装ワーカー

- 配線: 採用元`train/data/t087/v3-seed-3.bin`を既存v2と同じ流儀で`train/weights/pattern_v3.bin`と`app/public/pattern_v3.bin`へ配置し、Workerの`PATTERN_WEIGHTS_URL`を`pattern_v3.bin`へ切替。3ファイルともPWV3、SHA-256 `d815dd6fbfd3e426ec9f05a3cd0b3d6b5963e518d918bee85301ad83dbc0de92`で一致。v2は2,729,420 bytes、v3は5,964,708 bytes（+3,235,288 bytes、約2.19倍）。v2ファイルは両配置とも残した。
- WASM対応: 既存`Engine::load_pattern_weights`→`PatternWeights::from_bytes`がPWV3を処理できるため、エンジン／プロトコル拡張は不要。対局CPU・評価バー・棋譜解析・中盤練習等は共有Workerを通るため同じv3を使用する。詰めオセロの完全読み結果は仕様どおり静的評価重みに非依存。
- キャッシュ: `ANALYSIS_ENGINE_VERSION`を3→4へ更新。T107コメントは、棋譜解析が`allMoves: true`かつ`maxNodes`なしでquota非適用であることを明記する説明へ訂正。Service Workerはビルドごとに`CACHE_VERSION`へ一意値を注入しactivate時に旧Cache Storageを削除する既存機構であること、新規URL`pattern_v3.bin`がcache-firstで200取得後に保存されることを確認。ローカル本番成果物の`dist/sw.js`は`CACHE_VERSION='1784255940829'`へ置換された。
- v2切り戻し: `app/src/engine/worker.ts`の`PATTERN_WEIGHTS_URL`末尾を`pattern_v3.bin`から`pattern_v2.bin`へ1行戻し、`ANALYSIS_ENGINE_VERSION`を再度1つ上げる。
- eval一致・決定性: サンプルOBF `-------------------XO-----XOO-----OOO-----O-XO------XX------X---`（黒番）、depth 0で`eval_cli --pattern-weights train/weights/pattern_v3.bin`=`-8.74`、WASM `Engine.load_pattern_weights(app/public/pattern_v3.bin)`=`-8.74`。同一WASMリクエスト2回とも`-8.74`で一致。node-budget本番WASM検証も同一Engineで反復・無関係リクエスト後まで`d6 / 7.26 / depth 9 / 160000 nodes`の決定性を確認。
- 実行結果:
  - `cargo test -p engine`: PASS（194 passed、2 ignored。統合テスト4 passed）。
  - `cargo test -p engine --release --test ffo_bench -- --nocapture`: PASS。FFO #40=38、#41=0、#42=6、#43=-12、#44=-14で全期待値一致（641,077,417 nodes、61.390s）。
  - `npm test -- --run`: PASS（70 files、596 tests）。サンドボックスがNodeのforkとViteの`net use`子プロセスを拒否するため、実行中のみVitest poolをworker_threadsへ、Viteのネットワークドライブ照会を無効化し、終了後に両ファイルを原状復帰した。同じコマンド・全テストを実行。
  - `npx tsc --noEmit`: PASS。
  - 本番ビルド相当（`npx tsc -b`、`npx vite build`、`node scripts/test-node-budget-wasm.mjs`、`node scripts/inject-sw-version.mjs`）: PASS。`dist/pattern_v3.bin`は5,964,708 bytes、採用元と同一SHA。`wasm-pack build`単独再実行はサンドボックス外tempへのアクセス拒否で停止したが、エンジンソースは無変更で、既存生成WASMを使う後続ビルド・WASMロード検証はPASS。
  - ローカルHTTP: `/`=200、`/pattern_v3.bin`=200、Content-Length=5,964,708。操作可能ブラウザが環境に接続されていなかったため、ローカルUIの対局・解析・詰めオセロ実機操作は未実施。
- 未実施（オーケストレーター作業）: `.git`書込禁止のためコミットハッシュなし（代行コミット待ち）。mainへのpush、Actions成功確認、公開Pagesでの対局CPU（強）・解析・評価バー・詰めオセロ・v3取得200の実機確認は、コミット／push後に実施が必要。したがって本ワーカー時点ではタスク由来差分は意図的にworktreeへ残っている。