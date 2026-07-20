# T156c 最終レビューレポート

対象コミット: `c9aa39e1bd2a0462da0974d2d3880bfe95011b25`

確認範囲:

- `git diff c9aa39e~1..c9aa39e`
- `git log c9aa39e~1..c9aa39e`
- `engine/src/mpc.rs`
- `engine/src/search.rs`
- `engine/src/lib.rs`
- `engine/Cargo.toml`
- 設計レポートおよびT156bのpilot成果物
- 既存のexact、TT、analyzeAll、探索ポリシー周辺コード

変更は上記4ファイルだけで、スコープ外の差分はありません。`git diff --check`も問題ありません。

## (a) 重大（doneを止めるブロッカー）

なし。

外向き境界式は、fail-highを明示的ceil、fail-lowを明示的floorとしてQ16整数演算で実装しており、設計式と一致しています。

また、以下の重要な安全条件を満たしています。

- PV番兵窓ではMPC不発
- `empties > exact_from_empties + D` のexact境界ガード
- プローブ中のrecursive MPC禁止
- プローブ中のexact無効化
- 中断を含むプローブ終了後のフラグ復元
- MPCカット時に深さDのTT entryを直接格納しない
- analyzeAllでは構造的にMPC OFF
- 既存公開経路はすべてMPC default OFF

## (b) 中（次タスクで対応すべき）

なし。

`SearchPolicy`によりhistory、aspiration、MPCを独立制御でき、既存fixed-depth経路とノード予算経路の従来設定も保持されています。MPC有効化用の比較・校正入口も公開されており、T156dのベンチ配線に必要な実行時制御と統計取得が可能です。

`MpcStats`には設計§6で要求された全カウンタと深さヒストグラムが揃っています。

## (c) 軽微（記録のみ）

なし。

互換用の `REDUCTION` 定数は残っていますが、実探索からは参照されず、旧校正CLIの省略時引数専用であることが明記されています。「固定REDUCTIONからペア表へ移行」という要件には反していません。

作業ツリーにT157関連の未追跡ファイルがありますが、対象コミットの差分には含まれておらず、本タスクのスコープ逸脱ではありません。

## 検証評価

追加されたGate 0テストは、次を直接検証しています。

- 外向きmargin式と方向別境界直前・直後
- fail-high ceil / fail-low floor
- NWS幅1での外側プローブ窓
- PV番兵窓ガード
- exact境界ガード
- exact quota非消費
- ノード上限中断時の状態復元
- recursive MPC抑止
- 深さDのTT entry非格納
- MPC ONの決定性
- default OFF

作業ログおよびコミットログには以下の成功結果が記録されています。

- `cargo test -p engine`: 204 passed / 0 failed / 2 ignored
- FFO fast #40〜#44: 全問正解
- MPC feature付きテスト: 全パス
- feature有無双方の`cargo check`: 成功
- `git diff --check`: 成功

本レビュー環境はread-only指定のため、生成物を書き換える可能性のあるCargoテストの再実行は行っていません。

## (d) 総合判定

**合格**

カット式、固定小数点化、ペア表、適用境界、exact隔離、TT格納制約、runtime制御、テレメトリ、Gate 0テストのすべてがタスク仕様および設計レポートに整合しています。既存公開経路はMPC OFFのままで、FFO・既存テストの回帰も報告されておらず、doneを妨げる問題は認められません。