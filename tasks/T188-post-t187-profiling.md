---
id: T188
title: 高速化(7): T187後のRDTSC再プロファイル(次候補の実測選定)
status: in_progress
assignee: implementer
attempts: 0
---

# T188: 高速化(7): T187後のRDTSC再プロファイル(次候補の実測選定)

## 目的

T184(sort_by_cached_key、2.1〜2.3倍)・T185(固定長配列+next_board持ち越し、+1.7〜3.2%)・T186(legal_moves重複排除)・T187(増分評価、+37〜38%)の適用後、中盤探索の実コスト内訳は推定でしか分かっていない(T183のプロファイルはT184以前のもの)。次のアルゴリズム的高速化候補(ordering機構残余・スカラー特徴の増分化・flip計算のテーブル化・その他)へ投資する前に、T183と同じ手法で現時点の実測内訳を取り直し、優先順位を実測で決める。**コードの恒久変更は行わない計測タスク**。

## 背景・コンテキスト

- 前例: `tasks/T183-deep-profiling.md` と `bench/edax-compare/t183_profiling_report.md`。RDTSC一時計装(rdtsc/計測カウンタをsearch.rs等に一時挿入)→計測→**計装を完全に外して復元diffゼロ**という方式で実施済み。同じ方式を踏襲する。
- 計測対象バッチ: T183/T187と同じ中盤20局面(`bench/edax-compare/t156_mpc_positions.json` の split==test・空き29-36帯・先頭20件)、`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights pattern_v6.bin`、MPC off/on両方。
- T187で評価経路が増分化された(`PatternState::child`による差分更新+`score_with_state`)。旧「static_eval一括」ではなく、増分化後の新しい区間割りで計測する必要がある。

## 変更対象

- `engine/src/search.rs`・`engine/src/pattern_eval.rs` 等への**一時**計装(タスク完了時に完全除去、`git status --short`と`git diff`がクリーンであること)
- 成果物: `bench/edax-compare/t188_profiling_report.md` + raw JSON(これのみコミット)

## 要件

1. 少なくとも以下の区間を分離計測する(T183の区間割りを基礎に、T187後の構造へ更新):
   - `score_with_state`(葉評価本体)。可能なら内訳: パターン表引き部分 vs スカラー特徴(`scalar_features`、legal_moves_relativeフルスキャン)
   - `PatternState::child`(増分更新)と`PatternState::from_board`(ルートフル計算)
   - `ordered_moves` 合計と内訳(next_board生成=apply_move、orderingキーのモビリティ計算=next_board.legal_moves、ソート機構、tt_move昇格)
   - `legal_moves`(negascout冒頭)、`etc_try_cutoff`、`tt_probe`/`tt_store`、`hash_diff`、その他(残差)
2. MPC off/on 両方で計測し、区間別の時間・呼び出し回数・%wallを表にする。RDTSC計装のオーバーヘッド見積もり(T183と同様の注記)を含める。
3. レポートに「次の高速化候補の優先順位(期待削減幅の根拠付き)」を、少なくとも次の仮説候補について実測に基づき評価して記載する: (a)スカラー特徴の増分化ないし軽量化 (b)orderingのモビリティキー計算削減 (c)ソート機構の軽量化 (d)flips_for_moveのテーブル化 (e)TT probe/store改善。「候補に値しない(コスト僅少)」という結論も明記する。
4. 計測はマシン専有状態で行う(開始前にcargo/rustc/eval_cli等の不在を確認)。計装ビルドはrelease+計測フラグで行い、T183と同一条件にする。
5. 進捗・節目(計装完了・計測完了・復元完了)ごとにタスクファイルの作業ログへ追記する。

## やらないこと(スコープ外)

- 高速化の実装そのもの(候補選定まで。実装は次タスク)
- 計装コードの恒久コミット(レポート+raw JSON以外の差分を残さない)
- NPS前後比較(T187レポートで実施済み。本タスクは内訳の解明のみ)
- `tasks/` 配下・`CLAUDE.md` のコミット

## 受け入れ基準(検証コマンド)

- [ ] `bench/edax-compare/t188_profiling_report.md` + raw JSON がコミットされ、要件1〜3の内容(区間内訳表・MPC off/on・優先順位評価)を含む。
- [ ] 区間合計と総時間の残差が説明されている(T183同様、残差%を明記)。
- [ ] 計装の完全除去: `git status --short` で engine/ 配下に差分・未追跡ファイルがないこと。`cargo test -p engine` が全件パス(計装除去後の健全性確認)。
- [ ] レポートのみの変更のため、Pages実機確認は不要(エンジンコード不変)。push と Actions(Rust Tests)成功確認は行う。
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
