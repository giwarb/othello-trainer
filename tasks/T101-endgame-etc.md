---
id: T101
title: 終盤ソルバー: Exact ETC(子局面TT boundによる先行カット)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
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

## 作業ログ(担当エージェントが追記)
