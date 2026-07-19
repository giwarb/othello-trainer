---
id: T145
title: T139フォローアップ: テストコメント訂正・本番重み対称テスト・revert検証・exact経路計測
status: done # 2026-07-20 done裁定。cargo test 200件+CI Rust Tests success。verifier省略(コメント訂正+決定性テスト追加のみで、受け入れ基準の実行はCIが代替)。M2/M4の未達は仕様側の想定誤りと判明→STATUS申し送り化
assignee: implementer(Sonnet)
attempts: 0
---

# T145: T139レビュー指摘のフォローアップ

## 目的

T139(analyzeAll決定性、4612c66)の代替レビュー中4件(レポート: tasks/review/T139-analyze-symmetry-claude-review.md)を解消する。小粒だが本番評価の理解に関わる訂正を含む。

## 要件

1. **M1: pattern_eval.rs のテストコメント訂正**: 「PatternWeightsは実運用未配線・実害なし」という記述は誤り(本番はT122以降 v3×PatternWeights 配線済み: app/src/engine/worker.ts がpattern_v3.binをloadし全解析経路で使用)。コメントを事実に合わせて訂正する: D4不変性の破れ(compute_pattern_classesの整列方法、T044由来)は本番評価に効いており、非対称な合同局面ペアでは静的評価がズレうる。根本修正はD4 canonical化相当の別タスク(バックログ)であることも明記。
2. **M2: 本番重み構成での対称テスト追加**: protocol.rsの既存テストに倣い pattern重みbin(pattern_v2.binでよい)をロードした状態で、初期局面4合法手のanalyzeAll値一致テストを追加する(現行テストはweights=Noneのみ)。
3. **M4: revert-catching検証**: search.rsのループ先頭 `local_tt.clear()` を一時的に外し、T139の新規テスト(対称・決定性)が実際に失敗することを確認する(確認後に戻す。結果はタスク作業ログへ記録。テストが落ちない場合は落ちる条件にテストを強化する)。
4. **M3: 棋譜解析exact経路の影響計測**: 空き17〜22帯の局面サンプル(10〜20局面、既存ベンチ局面やoracle局面から流用可)で、ANALYZE_LIMIT相当(depth18/timeMs1500/exactFromEmpties22)のanalyzeAllを旧実装(4612c66^)と新実装で比較し、is_exactになる手の割合と壁時計を記録する。**退行が大きい場合も本タスクでは修正せず計測結果の報告のみ**(対応方針はオーケストレーター判断)。
5. L1のコメント微修正(protocol新テストの「TT状態引き継ぎ」説明)も同時に。

## スコープ外

- D4 canonical化・compute_pattern_classesの根本修正(バックログ)
- exact経路の退行が見つかった場合の対策実装
- ANALYSIS_ENGINE_VERSIONの再インクリメント(表示値が変わる変更は本タスクにはない想定。テスト・コメント・計測のみ)

## 受け入れ基準

1. `cargo test -p engine --lib` 全パス(新テスト含む)
2. M4のrevert検証結果(clear()除去でどのテストが落ちたか)が作業ログに記録されている
3. M3の計測結果(is_exact率・壁時計、旧vs新)が作業ログまたはbench配下レポートに記録されている
4. 変更ファイルはパス明示でコミットしmainへpush(エンジンのコメント・テストのみの変更ならPages実機確認は省略可、CIのRust Tests成功確認は行う)
5. タスク完了時点で当該タスク由来の差分・未追跡が `git status --short` に残っていないこと

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

### 2026-07-20 implementer(Sonnet)による実装

**M1(pattern_eval.rsテストコメント訂正)**: `score_is_invariant_under_all_eight_d4_symmetries_of_the_initial_position`のコメント中「`PatternWeights`は対局・解析のどちらの経路でも実運用では未使用」という事実誤認記述を訂正。本番はT122以降 `app/src/engine/worker.ts` が `pattern_v3.bin` をロードし全解析経路(analyzeAll含む)で使用していること、したがって`compute_pattern_classes`のD4不変性の破れは机上の懸念でなく本番評価に実際に効いていること、根本修正(D4 canonical化)は見送ったが影響がゼロという意味ではないことを明記した。

**M2(本番重み構成での対称テスト追加)**: 当初仕様どおり「初期局面4合法手のanalyzeAll値が完全一致する」テストを`pattern_v2.bin`ロード状態で実装したところ、**実際には一致しないことが判明した**(`assertion left==right failed: c4(score=-489) should exactly match d3(-151)`、depth=10/exactFromEmpties=12)。追加調査:
- `depth=1`(`mpc::MIN_DEPTH=5`未満、MPC不発動)の時点で既に大きく乖離(`pattern_v2.bin`, `exactFromEmpties=0`: d3=-765, c4=-1167, f5=-438, e6=-37)。MPCやTT共有と無関係に、静的評価(`PatternWeights::score`)自体のD4非不変性だけで生じる乖離であることを確認。
- `depth=12`(`app.tsx`の「強い」CPUレベル実設定、`exactFromEmpties=16`)でも、`pattern_v2.bin`で最大約0.09disc、本番配信中の`pattern_v3.bin`で最大約1.45disc相当の乖離が残存。
- 結論: 本番重み構成での「値一致」テストは原理的に書けない(書いても偶然の一致に依存する脆いテストになり、重み再学習で壊れる)。**タスク仕様の元々の想定(本番重みでも一致する)と食い違うため、この点はオーケストレーターへの申し送り事項とする。**
- 代替として、T139が実際に保証した性質(呼び出し元TTの状態からの独立性)を本番重み構成下で検証する決定性テスト`analyze_all_moves_from_initial_position_is_deterministic_with_production_weights_loaded`をprotocol.rsに追加した(warmup allMoves呼び出しを挟んでも同一結果になることを確認)。これは本番重み構成での自動テストが欠落していたギャップ(レビュー指摘M2後半)を実際に埋めるが、対称性(値一致)は主張しない。

**L1(protocol.rsコメント微修正)**: `node_unlimited_protocol_requests_are_deterministic_even_without_a_pre_clear`のコメントを訂正。「2回目・4回目とも直前の1回目が残したTT状態を引き継ぐ点は同じ」という説明は厳密には不正確で、実際には2回目の呼び出し自体が新たにTTへ書き込む影響が4回目の開始状態にだけ乗る非対称な構造であり、両者の開始TT状態が一致するのは「2回目の呼び出しで到達するTTエントリが1回目終了時点で既に不動点に達している」という経験的前提に依存していることを明記した。

**M4(revert-catching検証)**: `engine/src/search.rs`の`search_all_moves_with_eval`ループ先頭`local_tt.clear();`を一時的にコメントアウトし、`cargo test -p engine --lib`を実行。
- **結果: 200件全てPASS(1件も落ちなかった)**。T139の新規テスト(`search_all_moves_from_initial_position_gives_the_four_d4_symmetric_opening_moves_identical_scores`、`search_all_moves_is_deterministic_across_repeated_calls_even_with_a_prewarmed_local_state`、`node_limited_protocol_requests_are_deterministic`、`node_unlimited_protocol_requests_are_deterministic_even_without_a_pre_clear`)はいずれもこの退行を検知できなかった。
- 追加調査(release版eval_cliで実施、初期局面): `weights=None`でdepth 20(exactFromEmpties=12)まで深くしても4手は完全一致(すべてdiscDiff=0.0)。`pattern_v3.bin`でdepth=12(exactFromEmpties=16)の値もclear()除去前後で完全に同一(d3=1059, f5=1018, e6=1005, c4=914)。
- 「値一致(ground truth)」に基づくより厳格な代替テスト(各手のスコアを、着手後の局面に対する独立・新規TTでの単発`search()`呼び出しの結果と直接比較する案)を試作したが、**clear()を復元した正しいコード上でも同じアサーションが失敗した**(`search_all_moves_with_eval`の反復深化ロジックと`search()`のルート呼び出しの深さ規約が、この単純な1:1比較を裏付けるほど厳密に一致するとは限らないため。既存テスト`search_all_moves_max_score_matches_search_best_score`が保証するのは全候補手中の**最大値**が`search()`と一致することだけであり、個々の非最善手についての一致は文書化された不変量ではない)。この案は誤ったテストになるため採用せず破棄した。
- **結論(申し送り事項)**: このタスクで実施した範囲では、`local_tt.clear()`の削除を確実に検知する自動テストを追加できなかった。T139の新規テスト群は「対称局面同値」「呼び出し間の決定性」を検証するが、いずれも同一関数呼び出し内での手をまたいだTT汚染(今回のrevertが引き起こす退行の本体)には、少なくとも初期局面・depth 1〜20・heuristic/pattern_v2/pattern_v3の組み合わせでは反応しなかった。より感度の高い回帰テストの設計(例: транспозиции が実際に起きる局面の選定、TTサイズを縮小して衝突を誘発する等)には`search_all_moves_with_eval`の内部深さ規約のさらなる調査が必要と考えられ、本タスクの範囲(小粒なフォローアップ)を超えるため、フォローアップタスク化するかどうかはオーケストレーターの判断を仰ぐ。`local_tt.clear()`のコードは検証後に完全に復元済み(`git diff`でsearch.rsに差分なしを確認)。

**M3(棋譜解析exact経路の影響計測)**: `bench/edax-compare/t085_exact_positions.json`から空き17〜22の既存oracle局面20問を抽出(`exact-17-*`×4, `exact-18-*`×4, `t084-game-*-ply-*`(19〜22空き)×12)。T139直前(親コミット`e4ec74f`)とT139込みの現行コードでそれぞれ`eval_cli`をreleaseビルドし、`moves --depth 18 --time-ms 1500 --exact-from-empties 22 --pattern-weights train/weights/pattern_v3.bin`(=棋譜解析の`ANALYZE_LIMIT`相当、本番重み)で20局面を計測。
- 壁時計: 旧`total_wall=26.78s`(平均1.339s/局面) vs 新`total_wall=27.05s`(平均1.352s/局面)。**ほぼ同等(約1%増)**、レビュー懸念(共有TTのトランスポジション共有喪失による大幅遅延)は今回のサンプルでは顕在化しなかった。
- is_exact率: 旧`46/183=25.1%` vs 新`43/183=23.5%`。**約1.6ポイントの低下(183手中3手がexact→非exactに変化)**。レビューが懸念した「exact表示が減る退行」の方向性と一致するが、今回のサンプルでは小幅(重大ではない)。**本タスクでは対策せず計測結果の報告のみ**(スコープ外)。
- 生データ: `C:\Users\yoshi\AppData\Local\Temp\claude\...\scratchpad\m3_results.json`(セッション一時ディレクトリ、リポジトリ外)。

**受け入れ基準チェック**:
1. `cargo test -p engine --lib` 200 passed / 0 failed / 2 ignored — 満たす。
2. M4のrevert検証結果 — 上記のとおり作業ログに記録(ただし「テストが落ちない場合は落ちる条件にテストを強化する」は試行したが妥当な強化案を見つけられず未達、申し送り事項とした)。
3. M3の計測結果 — 上記のとおり作業ログに記録。
4. 変更ファイル(engine/src/pattern_eval.rs, engine/src/protocol.rs)をパス明示でコミット・push予定。search.rsは検証専用の一時変更で最終的に無差分。
5. `git status --short`はコミット後にクリーンになる見込み(下記コミット参照)。

**仕様との食い違い(オーケストレーター判断を仰ぐ点)**:
- M2は仕様が想定した「本番重み構成での値一致テスト」が実際には成立しない(調査の結果、静的評価のD4非不変性がMPC非依存で実測十数〜100centidisc規模で効いている)。決定性テストで代替した。
- M4は「テストが落ちない場合は強化する」を試みたが、初期局面・調査した深さ範囲では感度の高い代替テストを設計しきれず、既存テスト群の当該revertに対する検知力は実質ゼロのまま。追加の設計検討が必要か判断を仰ぎたい。
