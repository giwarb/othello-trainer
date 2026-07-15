---
id: T099
title: 終盤ソルバー: 候補生成の一回化とTT moveオーダリング
status: done # todo | in_progress | review | redo | done | blocked
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

### 2026-07-15 20:23 JST — Codex実装

- 実施内容:
  - engine/src/endgame.rs に MoveInfo を導入し、各合法手の着手マス、flip mask、子盤面、相手mobility、既存排序情報、TT move一致を一度だけ計算してソートと実探索で再利用。
  - 候補列の Vec<u64> を固定長 [MoveInfo; 64] に置換し、sort_unstable_by_key でヒープ依存を除去。
  - ExactドメインTT probeの best_move を合法性・マス範囲確認後に最優先化。既存キー順（隅、相手mobility昇順、連結領域パリティ）は維持し、最終キーにマス番号を追加。
  - TT move最優先とマス番号タイブレークのユニットテストを追加。公開API、abort契約、論理ノード定義は変更なし。
- 検証:
  - rustfmt --edition 2021 --check engine/src/endgame.rs — pass。
  - cargo test -p engine — 178 passed / 0 failed / 2 ignored。node_limited_protocol_requests_are_deterministic もpass。
  - cargo test -p engine endgame::tests::solve_exact_matches_naive_reference_on_small_positions — pass（naive differential一致）。
  - cargo test -p engine endgame::tests::move_info_sort_key_prioritizes_tt_move_and_breaks_ties_by_square — pass。
  - cargo test -p engine --release --test ffo_bench -- --nocapture — FFO #40〜44 全問正解。合計 1,298,251,990 nodes、484.374秒（#40=38、#41=0、#42=6、#43=-12、#44=-14）。
  - cargo build --release -p engine --bin eval_cli — pass。
  - python bench/edax-compare/endgame_bench.py run --suite c2 --checkpoint ＜一時領域＞ — T099 540/540完了。baseline JSONには個別C2ノード・時間がないため、同じコマンドをコミット ef9c1f1 の一時展開にも1回実行して比較。

| C2予算 | baseline nodes | T099 nodes | ノード差 | baseline時間 | T099時間 | 時間改善 |
|---:|---:|---:|---:|---:|---:|---:|
| 64k（3窓合計） | 11,520,000 | 11,520,000 | 0.00% | 5.493秒 | 4.355秒 | 20.72% |
| 160k（3窓合計） | 28,798,526 | 28,798,526 | 0.00% | 13.867秒 | 10.797秒 | 22.14% |
| 512k（3窓合計） | 91,200,946 | 91,200,946 | 0.00% | 43.464秒 | 34.078秒 | 21.59% |

| C2 512k窓 | baseline nodes | T099 nodes | baseline時間 | T099時間 | 時間改善 | 完走数 |
|---|---:|---:|---:|---:|---:|---:|
| fail-high | 29,760,946 | 29,760,946 | 14.461秒 | 11.222秒 | 22.39% | 5/60 → 5/60 |
| fail-low | 30,720,000 | 30,720,000 | 15.014秒 | 11.602秒 | 22.73% | 0/60 → 0/60 |
| full | 30,720,000 | 30,720,000 | 13.989秒 | 11.254秒 | 19.55% | 0/60 → 0/60 |

- 採否ゲート: C2ノード同等、512k系列の壁時計21.59%改善のため「ノード同等で壁時計10%以上改善」を満たす。
- fresh TT決定性: t096-exact-01、窓 [27,28]、max-nodes 512,000を2回実行し、両方 score=28 / nodes=158,526 / bound=lower / completed=true で完全一致。
- git diff --check — pass。
- コミット: 未実施（Codexサンドボックス制約）。オーケストレーター代行対象は engine/src/endgame.rs と本作業ログ。
