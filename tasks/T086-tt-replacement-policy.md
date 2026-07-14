---
id: T086
title: TT置換規則の品質保護(深いExactの保持・品質順序probe/store)
status: done # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T086: TT置換規則の品質保護

## 目的

現行TT(置換表)の store は同一hashなら無条件で depth_slot を上書きするため、**深いExactエントリが浅いUpper/Lowerで失われる**。probe も両slotの品質比較をしない。これを設計書の品質順序に基づく置換規則に改める。棋力を直接上げる施策ではなく、**以後の history/aspiration(T089a)・exact再利用を安定させる基礎修正**(設計書の位置づけ)。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§4(T086)**。§4.1(現状の欠陥)・§4.2(品質順序)・§4.3(store規則)・§4.4(ゲート)を規範として実装すること。
- 関連コード: `engine/src/tt.rs`(T085aでTTDomain分離済み: depthの未使用上位bitにdomainを符号化して16-byte entry/32-byte bucketを維持している。**この容量・レイアウト最適化を壊さないこと**)、`engine/src/search.rs`(probe/store呼び出し側)。
- T085aの教訓: 素直なフィールド追加はbucketを48バイト化し容量半減・FFOノード増を招く(実測済み)。

## 要件(設計書§4が規範。要点)

1. **品質順序**(§4.2): 同一hash・同一domainの比較は (1)depth深い > (2)同深度ならExact > (3)同深度・同BoundならLowerはscore大/Upperはscore小 > (4)同品質ならbest_move=Some優先 > (5)完全同等なら新しい方。**「浅いExact」より「深いbound」を優先**(浅いExactはその深さでの正確値に過ぎない)。
2. **store規則**(§4.3): 両slotから同一hash/domainを探す/新規が劣るならscore・depth・boundは上書きしない(ただし既存best_move=Noneで新規Someならmoveだけ補完可)/優れるなら高品質側へ昇格/同一hash/domainを両slotに重複保持しない/異なるhash衝突時はdepth slotに高品質・always slotに最新/depth slotから追い出したエントリはalways slotより高品質なら退避。
3. **probe**(§4.3末尾): 両slotを調べ、一致が2つあれば品質比較して良い方を返す(probe順序に依存しない)。
4. テスト: §4.4のゲート項目を直接assertするテスト群(深いExactが浅いboundのstoreで保持される/同深度boundへのExact storeで昇格/強いboundの保持/probe順序非依存/collision stress testで誤probeゼロ)。

## やらないこと(スコープ外)

- TT容量・エントリレイアウトの変更(16-byte entry/32-byte bucket維持)
- history/aspiration(T089a)、評価関数(T087/T088)
- アプリ/プロトコル/ベンチハーネスの変更(engine/src/tt.rs と search.rs の必要最小限のみ)
- MPC・exact切替条件の変更(T085aで確定済み)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(§4.4ゲートの新テスト含む)
- [ ] `cargo test -p engine tt::tests -- --nocapture` パス
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 正解値一致(ノード数は変化してよいが、増減と原因を作業ログに記録すること)
- [ ] fixed-depth探索のbest move/scoreがタスク前と一致(既存回帰テスト)
- [ ] `eval_cli budget-regression --manifest bench/edax-compare/t085_exact_positions.json --max-nodes 240000 --time-ms 1500 --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin` が決定的(deterministic:true)で、**48局面の中央値ノード数がタスク前比2%以上悪化しない**(§4.4。タスク前の基準値を最初に計測して作業ログに記録してから実装に入ること)
- [ ] 改善ノード数・TT hit/cutoff数の計測結果を作業ログに記録(§4.4)
- [ ] コミット対象ファイル一覧が最終メッセージに明記されている(コミット・pushはオーケストレーター代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(コミット代行後)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-14 18:03 JST — Codex実装

- 実施内容: `StoredTTEntry::quality_cmp` に depth → Exact → 同Bound内のscore強度(Lowerは大、Upperは小) → `best_move=Some` の品質順序を実装。`store` は両slotの同一hash/domainを探索し、劣る新規値から既存のscore/depth/boundを保護しつつmoveのみ補完、優る/同等の新規値を昇格、重複排除、異hash衝突時のdepth高品質保持・always最新保持・追い出し退避を行う。`probe` は両slot一致時に品質比較する。16-byte entry / 32-byte bucketは維持。
- テスト追加: 深いExactの浅いLower/Upperからの保護、同深度boundからExactへの昇格、深いboundと浅いExactの比較、Lower/Upper強度、moveのみ補完、probe順序非依存、追い出し退避、同一hash/domain重複排除、完全同品質時の新規優先、10,000エントリ衝突stressで誤probeゼロを直接assert。
- 実装前 budget-regression: `deterministic:true`、48局面中央値 214,325 nodes、合計 8,925,834 nodes。実装後: `deterministic:true`、中央値 214,190 nodes(差 -135、-0.063%)、合計 8,923,030 nodes(差 -2,804、-0.031%)。中央値は悪化せず、2%ゲートを満たした。move/scoreは全48局面で実装前と一致。
- TT統計: 現行CLIに統計出力がないため、一時的なAtomicカウンタをprobe hitと、NegaScout/ETC/endgameのTT即時return箇所へ追加して同じ48局面を2回ずつ探索した。集計は TT hit 2,325,456、TT cutoff 790,778。一時計測コードは直後に全て復元し、最終差分には含めていない。
- FFO #40-44: 全問正解。実装前→実装後 nodes は #40 42,133,930→42,038,895(-95,035)、#41 192,558,694→192,463,295(-95,399)、#42 266,858,189→266,602,242(-255,947)、#43 384,365,162→384,600,140(+234,978)、#44 413,186,354→412,952,212(-234,142)。合計 1,299,102,329→1,298,656,784(-445,545、-0.034%)。品質保護により保持されるTTエントリが変わったため局面別には増減したが、合計は微減。
- 実行コマンドと結果:
  - `cargo test -p engine tt::tests -- --nocapture`: 20 passed、失敗なし。
  - `cargo test -p engine`: 162 passed、2 ignored、失敗なし。`fixed_depth_exact_search_result_is_unchanged_from_the_pre_t084_baseline` と `fixed_depth_midgame_search_result_is_unchanged_from_the_pre_t084_baseline` を含む。
  - `cargo build --release -p engine --bin eval_cli`: 成功。
  - `eval_cli budget-regression --manifest bench/edax-compare/t085_exact_positions.json --max-nodes 240000 --time-ms 1500 --exact-from-empties 18 --pattern-weights train/weights/pattern_v2.bin`: 実装前後とも `deterministic:true`、上記ノード結果。
  - `cargo test -p engine --release --test ffo_bench -- --nocapture`: 1 passed、1 ignored、失敗なし、FFO #40-44全問正解。
  - `git diff --check`: 問題なし。
- コミット: N/A(`.git`書き込み禁止のため、オーケストレーターが代行)。
