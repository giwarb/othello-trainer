---
id: T145
title: T139フォローアップ: テストコメント訂正・本番重み対称テスト・revert検証・exact経路計測
status: todo # todo | in_progress | review | redo | done | blocked
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

(ワーカーが追記)
