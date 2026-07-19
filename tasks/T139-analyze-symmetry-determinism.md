---
id: T139
title: エンジン: 候補手評価の対称性・決定性の根本対応(TT共有/MPC由来の±1石ノイズ)
status: done # verifier(Pages実機Playwright込み全8項目)+代替レビュー(中4件はT145へ)両合格、2026-07-20
assignee: implementer(Sonnet)(Codex usage limit中のフォールバック)
attempts: 0
---

# T139: analyzeAllの対称性・決定性

## 目的

対局モードの候補手評価で、対称局面(初手d3/c4/f5/e6等)の評価値が±1石ズレる(T138調査で確定した機構: `search_all_moves_with_eval`が4手を同一TTで逐次探索+MPC近似枝刈り。engine/src/search.rs:1066-1229)。T138でブックcapにより序盤の実害は消えるが、ブック外の中盤では残る。根本対応として、表示用analyzeAllの「対称局面同値・実行順不変」を可能な範囲で確立する。

## 検討する選択肢(実装時にA/Bして採否判断)

1. `search_all_moves_with_eval`で各手の探索前にTTをクリア(または手ごとに独立TT)— 順序依存を除去。速度影響を計測(オーバーレイ用途なので多少の低速化は許容)。
2. analyzeAll経路のMPC無効化(`suppress_mpc: true`)— 近似性を除去。深さ低下/速度影響を計測。
3. 対称局面のcanonical化(4初手対称のみの特例でなく一般のD4 canonical化で探索し値を共有)— 効果は広いが実装大。
- 併せて `PatternWeights::score` の盤全体D4不変性を直接検証する単体テストを追加(explorer調査で欠落を確認済み)。

## 受け入れ基準(2026-07-20精緻化)

- [ ] 初期局面の4合法手のanalyzeAll値が完全一致する(自動テスト。可能なら初期局面以外の対称局面ペアでも)
- [ ] 同一局面のanalyzeAllを2回呼んで完全一致(TT状態に依存しない。事前にTTを汚す先行探索を挟んだケースを含む)
- [ ] FFO正解・既存エンジンテスト全パス(`cargo test -p engine`。既知フレーキー`node_limited_protocol_requests_are_deterministic`は単独再実行で切り分け)
- [ ] CPU着手経路(cpuLimit)のノード数・選択手が完全不変であることをテストまたはベンチ比較で示す(表示経路のみの変更であること)
- [ ] 速度影響の計測(analyzeAll 1回あたりの壁時計、変更前後)と採否判断の記録。オーバーレイ用途なので多少の低速化は許容だが、体感を損なう場合(目安2倍超)は選択肢を再検討
- [ ] **表示評価値が変わるため `ANALYSIS_ENGINE_VERSION` をインクリメント**(app/src/lib/cache.ts。解析キャッシュ混在防止、T122申し送りのコメント表現修正も同時に)
- [ ] wasm再ビルド→mainへpush→GitHub Actionsデプロイ成功→Pages実機(https://giwarb.github.io/othello-trainer/)で対局モードの候補手評価表示が動作し、初手4手の表示値が一致することをPlaywright等で確認
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-19/20 implementer(Sonnet)による実装

**採用した選択肢**: 選択肢1(手ごとに独立TT)。選択肢2(MPC無効化)・選択肢3(D4 canonical化)は不採用。

- 調査: `search_all_moves_with_eval`(engine/src/search.rs)は呼び出し元(`Engine::analyze`が保持し、対局CPU着手の探索とも共有される`tt`)を全合法手・全反復深化を通じて使い回していた。`handle_analyze`(protocol.rs)の`max_nodes.is_some()`分岐(cpuLimit相当)は呼び出し前に無条件`tt.clear()`していたため元々TT状態非依存だったが、`max_nodes`を指定しない経路(weak/normalレベル、strongレベルの空き20以下の終盤)はこの保険が無く、analyzeAllの呼び出し順序に本来依存しうる、より脆弱な経路だった。
- 実装: `search_all_moves_with_eval`から`tt`引数を削除し、関数内で`TranspositionTable::new(16)`のローカルTTを1つ確保、各合法手の探索直前に`local_tt.clear()`してから使う設計にした(同一手の反復深化の間は使い回す=速度低下を抑える)。`search_all_moves`・`protocol.rs`・`eval_cli.rs`・既存テスト(十数箇所)の呼び出しを合わせて更新。
- 選択肢2(MPC無効化)は不要と判断: 選択肢1だけで初期局面4合法手(d3/c4/f5/e6)の評価値が完全一致することを新規テスト`search_all_moves_from_initial_position_gives_the_four_d4_symmetric_opening_moves_identical_scores`で確認できたため、MPCはそのまま(`suppress_mpc: false`)有効にした。
- 選択肢3(D4 canonical化)は実装大のため見送り。
- **副次的発見(スコープ外として報告)**: `PatternWeights::score`の盤全体D4不変性を検証する単体テスト追加の過程で、任意の(非対称な)盤面に対しては現在の`patterns::compute_pattern_classes`の整列方法(対称オービットの`aligned_cells`決定が「セル集合が先に一致した対称変換」だけで決まり、軌道サイズが8未満のクラス=対角線・行・列・隅3x3で、盤面全体をD4変換した際に必要な「もう一方のセル順序」が記録されないことがある)が、厳密なD4不変性を保証しないことが判明した(位置重み付けエンコードのため並び順が結果に影響しうる。実測でクラス単位・数点相当のズレを確認、初期局面など内容自体がD4対称/空の盤面では発生しない)。T044由来の既存の設計上の制約でありT139のスコープ外と判断、`PatternWeights`が実運用でまだ配線されていないことも踏まえ、テストは初期局面(実際にT139が解決すべきシナリオ)に対象範囲を限定した(`pattern_eval.rs`の`score_is_invariant_under_all_eight_d4_symmetries_of_the_initial_position`、コメントに詳細記載)。将来PatternWeightsを配線する際は別タスクでの見直しを推奨。
- 速度影響のA/B計測: `git stash`で新旧コードを切り替え、`eval_cli moves --depth 12`(T076局面、weights=None、time_ms無指定)で計測。旧実装(共有TT): 6.14s/6.28s。新実装(独立TT): 6.32s/6.65s。数%程度の低速化に留まり許容範囲。
- CPU着手経路の不変性テスト: 既存`node_limited_protocol_requests_are_deterministic`(maxNodes=cpuLimit相当、間に無関係なallMoves呼び出しを挟んでも結果不変)が引き続き合格することを確認し、T139関連である旨のコメントを追加。加えて`max_nodes`を指定しない経路(weak/normal・strong終盤)向けに新規テスト`node_unlimited_protocol_requests_are_deterministic_even_without_a_pre_clear`を追加(こちらはT139以前は保険が無く、修正の効果を直接検証する)。
- テスト結果: `cargo test -p engine --lib` 199 passed / 2 ignored(release限定の既存2件)。`cargo test -p engine --test ffo_bench --release`(fast、#40-#44)全問正解。`npm run build`(app、wasm再ビルド込み)成功、`npx vitest run`(app)781 passed。
- `ANALYSIS_ENGINE_VERSION`を4→5に更新(app/src/analysis/cache.ts)、T122申し送り(worker.tsのv2/v3切り戻しコメントにANALYSIS_ENGINE_VERSION更新の必要性が無い件)もコメント追記で対応。
- コミット: `4612c66`(engine/src/search.rs, protocol.rs, pattern_eval.rs, bin/eval_cli.rs, app/src/analysis/cache.ts, app/src/engine/worker.ts)。push済み、GitHub Actions(Deploy to GitHub Pages・Rust Tests)両方成功を確認(run 29694473973 / 29694473932)。
- Pages実機確認: https://giwarb.github.io/othello-trainer/ で対局(強い・黒番開始)を実施、初期局面の4候補手すべてが同一の表示評価値(「黒番 評価値0」)になっていることをブラウザツールで確認、コンソールエラーなし。
- 作業中に気づいた点: `train/src/t090_distillation.rs`が(本タスクと無関係に)未コミットの状態で変更されていた。本タスクでは一切触れておらず、コミットにも含めていない(おそらく並行して動いている別タスクの成果物)。
- git状態: タスク完了時点で`git status --short`はT139由来の差分なし(train/src/t090_distillation.rsのみ残るが本タスク無関係)。

### 2026-07-20 verifier検証

- `git log`/`git show 4612c66 --stat`: 差分は報告どおり6ファイル(app/src/analysis/cache.ts, app/src/engine/worker.ts, engine/src/bin/eval_cli.rs, engine/src/pattern_eval.rs, engine/src/protocol.rs, engine/src/search.rs)のみ。`git status --short`は`train/src/t090_distillation.rs`(T144並行作業由来、T139無関係)のみで、T139由来の残差分なし。
- `cargo test -p engine --lib`: 199 passed / 0 failed / 2 ignored(34.23s)。フレーキー`node_limited_protocol_requests_are_deterministic`含め今回失敗なし(単独再実行不要)。
- `cargo test -p engine --test ffo_bench --release`: fast系1 passed(68.56s)、heavy系1 ignored(既存仕様どおり)。#40-#44全問正解。
- コードレビューで経路を直接確認: `search_all_moves_with_eval`(search.rs:1091-)は関数専用ローカルTT(`ANALYZE_ALL_LOCAL_TT_MB=16`)を確保し各合法手の直前に`local_tt.clear()`する設計になっており、呼び出し元TTを一切受け取らない(関数シグネチャに`tt`引数なし)。`protocol.rs`の`handle_analyze`はallMoves分岐でこの関数を`tt`を渡さず呼び、非allMoves分岐(通常analyze/CPU着手、maxNodes指定時は`tt.clear()`後、未指定時はそのまま)は従来どおり共有`tt`を使っており、CPU着手経路は変更の影響を受けない構造であることを確認。
- 新規テスト実効性確認: `search_all_moves_from_initial_position_gives_the_four_d4_symmetric_opening_moves_identical_scores`と`search_all_moves_is_deterministic_across_repeated_calls_even_with_a_prewarmed_local_state`はいずれも新シグネチャの`search_all_moves`/`search_all_moves_with_eval`(tt引数なし)を直接呼んでおり、ローカルTT経路を実際に通っている。`protocol.rs`の`node_limited_protocol_requests_are_deterministic`(maxNodes指定・cpuLimit相当)と`node_unlimited_protocol_requests_are_deterministic_even_without_a_pre_clear`(maxNodes未指定・weak/normal/strong終盤相当)はいずれも間に`allMoves:true`リクエストを挟んで前後の結果一致を検証しており、CPU着手経路の不変性を直接検証している。`pattern_eval.rs`の新規D4不変性テストは初期局面(D4対称)に対象範囲を限定しており、非対称盤面での既知の制約(スコープ外と判断)についてコメントで詳細に説明されていることを確認。報告内容と実装が一致。
- `app/src/analysis/cache.ts`: `ANALYSIS_ENGINE_VERSION = 5`を確認。
- `npx vitest run`(app/): 96 test files / 781 tests、全パス(15.99s)。
- GitHub Actions: commit 4612c66の"Deploy to GitHub Pages"(run 29694473973)・"Rust Tests"(run 29694473932)いずれも`completed success`を`gh run list`で確認。
- Pages実機確認: Playwright(npx cache経由でplaywrightパッケージを解決)で https://giwarb.github.io/othello-trainer/ を操作。モードカード「対局」→CPUの強さを「強い (depth12)」に変更→「黒番で開始」。`.move-eval-overlay__cell[title]`(初期局面の合法手4マスのみtitle属性を持つ)を取得したところ、4マスすべてが`title="黒番 評価値0"`・表示値"0"で完全一致。コンソールエラー0件。実装者報告と一致。
- 総合判定: 合格。受け入れ基準8項目すべて満たされていることを確認した。
