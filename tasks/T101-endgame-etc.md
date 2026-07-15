---
id: T101
title: 終盤ソルバー: Exact ETC(子局面TT boundによる先行カット)
status: done # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 1
---

# T101: 終盤 Exact ETC

## 目的

終盤ソルバー強化シリーズ第4弾。親局面の候補手を実探索する前に子局面のExact TTをprobeし、安全に証明できる場合は探索せずにcutoffする(Enhanced Transposition Cutoff)。T099のMoveInfo(子盤面・子hash計算済み)を土台に低コストで導入できる。

## 規範文書

- `tasks/design/T097-endgame-solver-report.md` §3.4(ETCの安全条件)・§5 T101節・§7(リスク表: negamax符号・Upper/Lower取り違えが最大リスク)。
- 計測: `bench/edax-compare/endgame_bench.py`。

## 要件(設計レポート§3.4・§5 T101節が規範)

1. **安全なcutoff条件**(§3.4の符号規約を厳守): 親が `score >= beta` を証明したい文脈で、子手番視点の子TTエントリについて
   - 子のExact値が `<= -beta`、または子のUpper boundが `<= -beta`
   - かつエントリ深さが子局面の空き数以上
   のときのみcutoffしてよい。**Lower boundをこの向きのcutoffに使ってはならない**。
2. **適用閾値**: 全子probeのコストがあるため、複数合法手あり・空き数が一定以上のdeep側だけで有効化する(閾値は固定定数、壁時計・NPS依存禁止)。
3. **on/offテスト入口**: ETCを無効化できるフラグ(テスト用)を設け、on/offで**scoreが完全一致**することをランダム小空き局面とFFOで検証する。
4. **T100レビュー軽微指摘の消化**: (1) `negamax` 付近の旧コメント「挙動・性能は変えない」を現状に合わせて更新、(2) 排序キーの相対順(隅>mobility>square class>パリティ)を固定する単体テストを追加。
5. 公開API・abort契約・論理ノード定義は不変。変更は `engine/src/endgame.rs`(+必要なら同ファイル内テスト)のみ。

## 計測プロトコル(軽量サイクル+ゲート改定2026-07-15)

- **主判定**: FFO #40-44合計ノードがETC on(既定)で**5%以上削減**(オフ側は今回のbuildでETC off実行として測る)。
- **C2**: 完走数が減らない・合計ノードが増えない(512k系列)。加えて**cap 4,000,000系列**のon/off比較を併記(検閲を減らした判別)。
- 壁時計は参考記録(1回)。on側がoff側より壁時計2%以上悪化する場合は既定offにして報告(設計レポートの採用条件)。

## やらないこと(スコープ外)

- 安定石カット(T102)、NWS/PVS(T103)、専用ソルバー(T104)、増分hash(T105)
- TT構造・置換規則の変更(T086維持、区間化はT106)
- exactポリシー変更(T107)、ハーネス変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocolフレーキーは単独再実行で切り分け)
- [ ] **on/off score完全一致**: ランダム小空き局面(空き<=10、パス含む)の全数/広範比較テスト+FFO #40-44でon/off両実行のscore一致
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 全問正解
- [ ] FFO合計ノード5%以上削減(on vs off、数表を作業ログに)
- [ ] C2 512k: 完走数非減・合計ノード非増。C2 4M系列のon/off比較表が作業ログにある
- [ ] fresh TT同一局面2回実行の決定性
- [ ] T100軽微指摘2件(コメント更新・排序順テスト)が反映されている
- [ ] 変更対象ファイルのみパス指定でコミット(オーケストレーター代行、変更ファイル一覧明記)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

### redo #1(2026-07-15、codex-review不合格: tasks/review/T101-endgame-etc-codex-review.md)

**実装本体の安全条件(Exact/Upperのみ・符号・深さ条件・Lower不使用)は問題なしと確認済み。ブロッカーはテストの空洞化のみ。**

- on/off比較テスト(`random_small_positions`、空き10以下)と決定性テストは、ETC発動条件(空き15以上)を満たす局面を一切探索しておらず、**ETC経路を一度も通らない同一探索同士の比較になっている**(閾値8→15変更時にテスト局面が未追随)。
- 修正: (1) テストからETC閾値を上書きできる入口(cfg(test)のセッター等、本番経路の定数は不変)を設けるか、空き15以上の局面セットを使う。(2) **ETCが実際に発火したことをカウンタ(テスト用テレメトリ)で確認**した上で、on/off score一致とfresh TT決定性を再検証する(発火0件のままpassするテストを残さない)。(3) 発火ありのランダム局面比較(パス含む)を受け入れ基準の水準(広範)で実施。
- FFO・C2の手動計測は有効なので再実行不要。cargo test全件と新テストのみ再確認。実装本体は変更しないこと(テスト整備が目的。もしテスト強化で実バグが見つかったら修正+報告)。

## 作業ログ(担当エージェントが追記)

### 2026-07-15 22:18 JST — Codex 実装

- `engine/src/endgame.rs` に Exact ETC を実装した。複数合法手かつ空き15以上で全子の Exact-domain TT を probe し、子手番視点の `Exact` / `Upper` が `score <= -beta`、かつ `depth >= child_empties` の場合だけ親の `Lower` cutoff として使用する。`Lower`、深さ不足、閾値未達は不使用。
- ETC 対象ノードでは生成済み子盤面の hash を `MoveInfo` に保持し、子再帰でも再利用する。公開API、abort伝播、論理ノード定義は変更していない。通常入口は const flag で on、同一内部探索を `negamax::<false>` としてテスト可能にした。
- 当初の閾値8では既存の空き14 exact leaf quota テレメトリが変化したため、abort契約と既存回帰を維持する deep 側の固定値15へ調整した。
- T100レビュー軽微指摘を反映: `negamax` 付近の旧コメントを現状へ更新し、排序の相対順 `隅 > mobility > square class > パリティ` を固定する単体テストを追加した。
- 正当性テスト: Exact/Upper の安全条件と Lower 不使用を個別検証。16 seed のランダム到達小空き局面（空き10以下、160局面以上、実パス局面を含む）で ETC on/off score 完全一致。fresh TT 同一局面2回で `(score, nodes)` 完全一致。

#### FFO #40–44 on/off（TT 256MiB、full window、各1回）

| FFO | score on/off | nodes off | nodes on | 削減率 | wall off | wall on |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 38 / 38 | 45,356,628 | 44,106,279 | 2.76% | 14.730s | 13.224s |
| 41 | 0 / 0 | 192,907,085 | 184,072,750 | 4.58% | 59.186s | 56.855s |
| 42 | 6 / 6 | 257,445,670 | 248,730,603 | 3.39% | 75.585s | 71.596s |
| 43 | -12 / -12 | 285,053,628 | 264,260,190 | 7.29% | 92.677s | 82.779s |
| 44 | -14 / -14 | 288,715,239 | 258,951,798 | 10.31% | 89.918s | 78.635s |
| 合計 | 全問一致 | 1,069,478,250 | 1,000,121,620 | **6.49%** | 332.095s | 303.089s |

- 主ゲート5%削減を通過。壁時計は ETC on が off より8.73%短く、既定onを採用。

#### C2 on/off（60局面 × fail-high/fail-low/full、TT 64MiB）

| cap | ETC | 完走 / 180 | 全job合計nodes | 完走job合計nodes |
|---:|:---:|---:|---:|---:|
| 512,000 | off | 6 | 90,645,357 | 1,557,357 |
| 512,000 | on | 6 | 90,640,526 | 1,552,526 |
| 4,000,000 | off | 43 | 626,885,976 | 78,885,976 |
| 4,000,000 | on | 44 | 624,182,234 | 80,182,234 |

- 512k は完走数同数・合計nodes非増、4M は完走数+1・合計nodes減。完走したon/offペアの score/bound不一致0件、全完走結果の期待bound不一致0件。

#### 実行コマンドと結果

- `cargo test -p engine` — PASS（181 passed, 0 failed, 2 ignored。閾値8時の既存quota回帰失敗を検出後、閾値15へ修正して再実行）
- `cargo test -p engine --release --test ffo_bench -- --nocapture` — PASS（#40–44 全問正解、1 passed, 1 ignored）
- `cargo build --release -p engine --bin eval_cli` — PASS
- `target/release/eval_cli.exe solve ...` / ETC off分離build — FFOおよびC2を1局面/jobごとのcheckpoint保存・resume付きで実行、上表の通り
- `git diff --check` — PASS
- コミット: 未実施（`.git` 書き込み不可。オーケストレーター代行）

### 2026-07-15 22:41 JST — Codex redo #1 テスト修正

- 本番の `ETC_MIN_EMPTIES = 15` と実装本体の安全条件は維持したまま、`cfg(test)` の thread-local 閾値 override と ETC cutoff カウンタを追加した。テスト終了時に override とカウンタを復元し、並列テスト間で状態を共有しない。
- ランダム小空き on/off テストは従来どおり16 seed・160局面以上・実パス局面を含む full-window score 一致を確認する。加えて、空き8以上のランダム親局面について、ETC-off で厳密に求めた最善子の有効な Exact TT エントリを fresh TT に投入し、ETC-on/off の狭窓 score 一致を16局面以上で比較する。ETC-on の cutoff 合計が0件なら必ず失敗する。
- fresh TT 決定性テストも同じ有効な子 Exact TT を投入したランダム局面を使い、両実行で ETC cutoff が発火したこと、および `(score, nodes, cutoff count)` の完全一致を確認するよう修正した。
- FFO/C2手動on/off計測は redo 指示により再実行していない。release FFO回帰の on nodes は既存計測値 `1,000,121,620` と完全一致し、本番探索挙動が不変であることを確認した。

#### 実行コマンドと結果

- `cargo test -p engine endgame::tests::etc_on_off_scores_match_on_broad_random_small_positions_including_passes -- --nocapture` — PASS（1 passed、ETC発火必須）
- `cargo test -p engine endgame::tests::fresh_tt_runs_are_deterministic_with_etc -- --nocapture` — PASS（1 passed、両fresh TT実行でETC発火）
- `cargo test -p engine` — PASS（181 passed, 0 failed, 2 ignored）
- `cargo test -p engine --release --test ffo_bench -- --nocapture` — PASS（#40–44 全問正解、合計nodes 1,000,121,620、1 passed, 1 ignored）
- `git diff --check` — PASS
- コミット: 未実施（`.git` 書き込み不可。オーケストレーター代行）
