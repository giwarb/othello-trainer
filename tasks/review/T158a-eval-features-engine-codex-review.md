# 最終レビューレポート — T158a redo #1

対象コミット: `2bd6214fde4284e5c9f260dba46ebccd1fc8e101`

## (a) 重大（done を止めるブロッカー）

### native/WASM 間の探索結果一致が機械検証されていない

タスク仕様の Gate 0 は、native/WASM の固定 fixture について score・best move・nodes の一致を要求しています。しかし今回の実装は、それぞれのランタイム内で以下だけを検証しています。

- baseline とゼロ係数PWV4の一致
- baselineの7反復間の一致

WASM側は [t158a_engine_cost_bench.mjs](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t158a_engine_cost_bench.mjs:123) でWASM内の反復を比較し、native側も [eval_features_nps_bench.rs](C:/Users/yoshi/work/othello-trainer/engine/tests/eval_features_nps_bench.rs:338) でnative内の反復を比較していますが、両者のreferenceを相互比較する処理はありません。

さらに、以前WASMスクリプトにあった既知のnative fixture値とのassertが削除され、今回の8局面については代替の共通goldenも追加されていません。レポートは「native/WASMの8局面すべてでmove・score・depth・nodesが一致」と記載していますが、[meta.json](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t158a_engine_cost_report.meta.json) に局面別探索結果が保存されておらず、コミット内容からその一致を再検証できません。

nativeとWASMが共通で検査する探索結果goldenを追加するか、両方の出力を比較する機械検証が必要です。明示されたGate 0要件を満たしていないためブロッカーと判定します。

## (b) 中（次タスクで対応すべき）

### WASM計測artifactの再現手順と来歴が不足している

WASMバイナリはgit管理外であり、レポートの再現コマンドからWASM build手順も削除されています。[レポート](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t158a_engine_cost_report.md:111) は「前回T158aで生成済みのrelease artifact」としていますが、今回のmetaに記載されたSHA-256は親コミットのレポートに記載されたSHA-256と異なります。

現ワークスペースの `engine_bg.wasm` は今回記載されたSHA-256と一致しましたが、クリーンcheckoutから同じartifactを再生成するための正確なコマンド・オプションが残っていません。Gate判定の測定物として、ビルドコマンドと生成条件をレポートまたはmetaへ固定すべきです。

## (c) 軽微（記録のみ）

- 旧単一局面ベンチ `zero_feature_model_is_identical_and_native_cost_is_reported` が無条件の `#[ignore]` に変更されたまま残っています。層化ベンチへ完全移行したのであれば、将来の整理対象です。
- PWV3 golden fixtureは有効な回帰防止になっています。ただしコメントの「parent commit before PWV4/scalar-feature integration」は、レビュー対象コミットの直接の親には既にPWV4実装が存在するため、どのコミットから採取した値かハッシュを明記すると来歴が明確になります。

## 確認できた妥当な点

- `t156_mpc_positions.json`の4空き帯から各2局面を固定し、序盤・中盤・終盤接続前を含む8局面へ層化されています。
- native/WASMともfresh TT、7反復、反復ごとのbaseline/candidate先行順反転を実装しています。
- 固定深さと160k層の両方でbaseline/candidate一致および反復間決定性を直接検査しています。
- PWV3の8局面 `f32::to_bits()` golden fixtureが追加されています。
- レポートとmetaには帯別・集計比率および帯別の支配要因が記載され、WASM固定深さ集計96.58%、帯別最低95.94%というGate 1判定自体は規定の90%基準を満たしています。
- 160k/1500ms層は全帯でノード上限支配、時間切れ0件と記録されています。
- appおよび本番評価コードへの追加変更はなく、redoの変更範囲は概ね適切です。

## (d) 総合判定

**不合格**

redo #1の中心課題だった複数ステージ計測、PWV3 golden、ランタイム内の反復間決定性は適切に補強されています。Gate 1の性能値も合格基準を満たしています。

一方、必須のGate 0項目であるnative/WASM間の探索結果一致が機械検証されず、裏付けとなる局面別結果もコミットされていません。レポートの一致主張をコードまたは保存済み測定データから再確認できないため、この点を修正するまでdoneにはできません。