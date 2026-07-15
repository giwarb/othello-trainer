---
id: T099
title: 終盤ソルバー: 候補生成の一回化とTT moveオーダリング
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T099: 候補生成の一回化とTT move排序

## 目的

終盤ソルバー強化シリーズ第2弾(最初のノード削減施策)。現行 `engine/src/endgame.rs` は (a) 各候補をソート評価時と実探索時に2回 `apply_move` する、(b) TTに保存した `best_move` を手順排序に使っていない、(c) `Vec<u64>` のヒープ確保でソートする——を改める。

baseline(T098確定、`bench/edax-compare/endgame_baseline.json`): native/Edax速度比は幾何平均135.7倍(空き20〜24)。シリーズ全体でC2証明ノード中央値を1/20へ削減する必要があり、本タスクはその第一歩。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §3.3(MoveInfo・推奨優先順)・§5 T099節・§7(リスク表)。
- 計測: T098で整備済みの `bench/edax-compare/endgame_bench.py`(C2証明窓)と `eval_cli solve`。

## 要件(設計レポート§5 T099節が規範)

1. **MoveInfo導入**: 各候補につき着手マス・flip mask・子盤面・(必要なら)子hash・相手合法手数などを**一度だけ**計算する構造体を導入し、ソートと実探索で再利用する。
2. **TT move優先**: Exact TT probeで得た `best_move` を排序の先頭に置く(TT moveが非合法・古い場合は安全に無視する。設計レポート§5 T099「主リスク」参照)。
3. **ヒープ依存の除去**: `Vec` を固定長配列/small stack buffer(最大合法手数は既知の上限)に置き換える。
4. **決定的タイブレーク**: ソートキーの最後にマス番号を必ず入れ、同点時の順序を明示的に固定する(TT move由来の非決定性防止)。
5. 既存のソートキー(隅優先・相手mobility昇順・連結領域パリティのタイブレーク)は本タスクでは順序変更しない(パリティ改革はT100)。TT moveを最上位に足すのみ。
6. `endgame.rs` 以外のアルゴリズムは変えない。公開API・abort契約・ノード定義(論理局面カウント)は不変。

## 計測プロトコル(ユーザー裁定2026-07-15: 軽量サイクル)

- 採否ゲートは**決定的なノード数比較(1回実行)**で判定する。速度反復・warmupの儀式は不要(壁時計は参考値として1回分記録すればよい)。
- C2証明窓(`endgame_bench.py`、予算512k系列が最も判別力が高い)の施策前後ノード数を比較する。施策前はコミット `ef9c1f1` のbaseline JSONを使う(再計測不要)。

## やらないこと(スコープ外)

- パリティ・排序キー自体の再設計(T100)、ETC(T101)、安定石(T102)、NWS/PVS(T103)、専用ソルバー(T104)
- exactポリシー・quota変更(T107)
- `search.rs` / `eval_cli` / ハーネスの変更(バグを見つけたら報告のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(※`node_limited_protocol_requests_are_deterministic`はフル並列時に既存フレーキー実績、失敗時は単独再実行で切り分け)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 全問正解(正解値不変)
- [ ] naive solver(既存のnaive/differentialテスト)との一致テストがパス
- [ ] C2証明窓の合計ノード数が baseline比 **10%以上削減**、またはノード同等で壁時計10%以上改善(結果を作業ログに数表で記録)
- [ ] fresh TT条件で同一局面2回実行 → score/nodes/bound完全一致(決定性)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックス制約のためオーケストレーター代行、変更ファイル一覧を完了レポートに明記)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
