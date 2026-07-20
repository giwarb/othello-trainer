# 最終レビューレポート — T158a

対象コミット: `138217bb981d520a3cdfb2bef76e0c6aec88b34c`

## (a) 重大（done を止めるブロッカー）

### 1. Gate 1の探索計測が単一の序盤局面だけで、設計§6.3の計測条件を満たしていない

固定深さNPSと160kノード計測は、native/WASMとも同じ1局面だけを使用しています。

- native: [eval_features_nps_bench.rs:153](C:/Users/yoshi/work/othello-trainer/engine/tests/eval_features_nps_bench.rs:153)
- WASM: [t158a_engine_cost_bench.mjs:53](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t158a_engine_cost_bench.mjs:53)

この局面は黒6石・白10石、空き48マスの序盤局面です。設計§6.3は「序盤・中盤・終盤接続前を含む複数局面」を明示的に要求しています。exact mobilityの実行コストは石配置や合法手生成の展開状況に依存するため、この単一局面の95.94%だけでは本番WASMのGate 1判定材料として不足しています。

microbenchには複数局面がありますが、Gate判定に使用した固定深さ探索NPSは単一局面です。また160k層も同じ序盤局面なので、中盤・終盤接続前の時間上限対ノード上限の支配性も確認できていません。

したがって、複数stageの固定コーパスを用いてnative/WASMの固定深さNPSと160k/1500msを7反復交互順で再計測し、その集計値でGate 1を再判定する必要があります。

## (b) 中（次タスクで対応すべき）

### 1. 現行 `pattern_v4.bin` の「変更前スコアとの完全一致」が独立したgolden値で機械検証されていない

[pattern_eval.rs:1091](C:/Users/yoshi/work/othello-trainer/engine/src/pattern_eval.rs:1091) のテストは、変更後loaderで読み込んだPWV3と、そこから生成したゼロ係数PWV4を比較しています。この比較はPWV4ゼロ係数の検証にはなりますが、PWV3 loader/score自体が変更前コミットと一致することは独立には証明しません。

固定探索には `score=1109`、`nodes=183318` のgolden値がありますが、現行モデルの複数局面における静的評価値のbit-exact golden fixtureはありません。受け入れ条件に明記された「現行 `pattern_v4.bin` のスコア完全一致」を確実にするため、親コミットで採取した複数stageの `f32::to_bits()` を固定fixtureとして比較すべきです。

### 2. fresh TTでの反復決定性チェックが一部、反復間比較になっていない

native計測では各反復内のbaseline/candidate一致は検証していますが、baselineの結果が7反復を通じて同一であることは直接比較していません。[eval_features_nps_bench.rs:156](C:/Users/yoshi/work/othello-trainer/engine/tests/eval_features_nps_bench.rs:156)

WASMも固定深さbaselineは反復間比較しますが、160k結果の `productionReference` は保存するだけで、その後の反復と比較していません。[t158a_engine_cost_bench.mjs:121](C:/Users/yoshi/work/othello-trainer/bench/edax-compare/t158a_engine_cost_bench.mjs:121)

現在の結果はノード上限支配なので実害が出る可能性は低いものの、Gate 0の「同一入力・fresh TTで反復一致」を直接満たす検証へ補強するのが妥当です。

## (c) 軽微（記録のみ）

### 1. 計測専用メソッドが通常のWASM公開APIに追加されている

[lib.rs:115](C:/Users/yoshi/work/othello-trainer/engine/src/lib.rs:115) の `benchmark_pattern_eval` は計測専用ですが、`#[wasm_bindgen] impl Engine` 内にあり通常ビルドの公開APIを増やします。設計上ベンチ入口は必要で、既定解析結果にも影響しないためブロッカーではありません。ただし本番API面を最小化するなら、将来ベンチ用featureで条件付きコンパイルする余地があります。

### 2. レビュー環境ではテストを再実行できなかった

`cargo test -p engine` を試行しましたが、read-onlyレビュー環境のため `target/debug/.cargo-build-lock` へのアクセスが拒否されました。したがってテスト結果はコミット内の作業ログおよび計測レポートを確認したもので、今回のレビュー環境による独立再実行結果ではありません。

なお、`git diff --check 138217b~1..138217b` は問題なく、作業ツリーもクリーンでした。

## 実装評価

特徴primitive、符号規約、D4不変性、PWV4の形式、schema hash、未知kind・重複・scale・reserved・非finite・余剰bytesの拒否、PWV4のみの固定順加算は仕様に沿っています。PWV1～3はscalar配列が空なら従来のpattern加算後に追加演算へ入らず、既定のPWV3本番経路を維持する構造も妥当です。

`--disable-eval-features` はモデル読込直後に適用され、各探索がfresh TTを生成するベンチ経路も適切です。報告されたbaseline SHA-256もリポジトリ内 `pattern_v4.bin` と一致しました。

## (d) 総合判定

**不合格**

主要実装の正しさと後方互換性には明白な機能バグを認めません。しかし、Gate 1の主判定値が設計で必須とされた複数stageの局面集合ではなく、空き48マスの単一局面から算出されています。この状態では95.94%を本番WASM全体のGate通過根拠にできず、タスクの中心成果である純コスト判定が未完了です。

複数の序盤・中盤・終盤接続前局面で3層の計測を再実施し、Gate 1判定と支配要因を更新した後に再レビューが必要です。