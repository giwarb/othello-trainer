# T158a engine scalar feature cost report

計測日: 2026-07-21 (Asia/Tokyo)

## 結論

Gate 0は合格。ゼロ係数PWV4はPWV3 baselineと、8局面×7反復のnative/WASM探索で
best move・score・depth・nodes・PVが完全一致した。PWV3自体も親コミットで採取した
8局面の`f32::to_bits()` goldenと一致した。

Gate 1の主判定値である、4空き帯8局面を合算したWASM固定深さNPS比は **96.58%**。
帯別最低値も95.94%で、事前登録した90%基準を上回るため **Gate 2へ進む**。

本番相当の`maxNodes=160000`, `timeMs=1500`ではnative/WASMとも全8局面が
160,000ノード（exact quota境界の1局面だけ160,002）へ到達し、時間切れは0件だった。
全帯で **時間上限ではなくノード上限が支配的** である。

## Gate 0

- PWV1〜PWV3の既存loader/score経路は不変で、全既存テストがPASS。
- PWV4 round-tripと、未知kind・重複・scale・reserved・非finite・stage・hash・余剰bytesの破損拒否がPASS。
- PWV4だけpattern和の後にkind 1→2の固定順でscalar項を加算。
- 色交換で符号反転、全D4で不変、囲い度を独立8×8二重ループ実装と比較して一致。
- ゼロ係数PWV4とPWV3を40 plyの静的評価列、および層化8局面の探索でbit-exact比較。
- nativeは固定深さ・160k両方のbaseline結果を7反復間で直接比較。
- WASMも固定深さ・160k両方のbaseline結果を7反復間で直接比較。
- native/WASMの8局面すべてでmove・score・depth・nodesが一致。
- 親コミット由来PWV3 golden bits（corpus順）:
  `1096847631, 1050921104, 1087962051, 3258694572, 3245183306, 3240604642, 3252197972, 3225423250`。

`cargo test -p engine`: engine library 210 passed / 0 failed / 2 ignored。各bin/integrationも全PASS。
既存NPSベンチはpattern/heuristic比0.867でPASS。FFO fast #40〜#44は全問PASS
（641,077,417 nodes、59.674s、10,743,009 NPS）。

## 固定corpus

`t156_mpc_positions.json`の各空き帯から、`pilot=true`かつ`split=calibration`の先頭2局面を
決定的に選び、`t158a_engine_cost_positions.json`へbitboardと出典IDを固定した。

| 空き帯 | fixture IDs | empties |
|---|---|---:|
| 45-52 | mpc-45-52-calibration-001 / 002 | 47 / 52 |
| 37-44 | mpc-37-44-calibration-001 / 002 | 42 / 37 |
| 29-36 | mpc-29-36-calibration-001 / 002 | 33 / 36 |
| 21-28 | mpc-21-28-calibration-001 / 002 | 27 / 25 |

これは序盤、中盤、終盤接続前を含む。同じJSONをnative/WASMの双方が直接読む。

## Gate 1 計測条件

- release、専有状態、warm-up後7反復、baseline/candidate交互順（反復ごとに先行を反転）。
- 各探索はfresh TT 64MB。固定深さはdepth 9・`exact_from_empties=0`。
- 本番相当層はdepth 12・160k nodes・1500ms・`exact_from_empties=16`。
- 各反復は8局面をすべて測り、集計値は反復ごとの8局面elapsed合計の中央値。
- baseline: `train/weights/pattern_v4.bin`、SHA-256
  `c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`。
- candidate: pattern本体が同一で2 scalar係数が全0のPWV4、SHA-256
  `3d4bdb7aa58ae0116983c47052230c26886a9823a981b28614eae47b397f6dd1`。
- native: rustc 1.96.1、x86_64-pc-windows-msvc、LLVM 22.1.2。
- WASM: wasm-bindgen 0.2.126、Node v22.13.0、Windows x64。WASM SHA-256
  `c51b1d7c7c563352daf01c9a93890e998043352a3daebec9f9ba624809c1d4f2`。
- CPU識別子: AMD64 Family 25 Model 80 Stepping 0。OS: Windows 10.0.26200.0。
- microbenchは入力とscoreを`black_box`で消費し、ゼロ係数でもfeature計算を実行。

## 3層の集計結果

比率は`baseline elapsed / candidate elapsed`。同一ノード集合の固定深さ探索ではNPS比に等しい。

| runtime / layer | baseline median (range) | PWV4 zero median (range) | ratio |
|---|---:|---:|---:|
| native eval 200,000回 | 73.527 ms (69.731–88.579) | 87.619 ms (86.594–98.428) | 83.92% |
| native 固定深さ8局面合計 | 2443.503 ms (2410.029–2756.985) | 2530.526 ms (2512.785–2777.997) | 96.56% |
| native 160k/1500ms 8局面合計 | 2222.534 ms (2153.209–2414.695) | 2248.462 ms (2213.911–2457.920) | 98.85% |
| WASM eval 150,000回 | 58.805 ms (57.955–60.480) | 71.206 ms (67.500–73.592) | 82.58% |
| WASM 固定深さ8局面合計 | 2143.870 ms (2124.590–2205.298) | 2219.792 ms (2198.656–2237.891) | **96.58%** |
| WASM 160k/1500ms 8局面合計 | 1961.672 ms (1953.260–1979.162) | 2012.495 ms (2005.983–2033.693) | 97.47% |

## 帯別結果と支配要因

| runtime | empty帯 | 固定深さ base / candidate ms | NPS比 | 160k base / candidate ms | elapsed比 | 支配要因 |
|---|---|---:|---:|---:|---:|---|
| native | 45-52 | 1391.761 / 1444.245 | 96.37% | 594.334 / 601.696 | 98.78% | nodes 2/2 |
| native | 37-44 | 458.491 / 466.362 | 98.31% | 630.983 / 641.340 | 98.39% | nodes 2/2 |
| native | 29-36 | 405.192 / 426.827 | 94.93% | 617.540 / 590.344 | 104.61% | nodes 2/2 |
| native | 21-28 | 189.796 / 195.044 | 97.31% | 387.168 / 401.743 | 96.37% | nodes 2/2 |
| WASM | 45-52 | 1220.229 / 1271.884 | 95.94% | 527.456 / 540.766 | 97.54% | nodes 2/2 |
| WASM | 37-44 | 393.096 / 402.632 | 97.63% | 555.758 / 566.460 | 98.11% | nodes 2/2 |
| WASM | 29-36 | 356.282 / 365.430 | 97.50% | 518.612 / 531.586 | 97.56% | nodes 2/2 |
| WASM | 21-28 | 168.602 / 174.147 | 96.82% | 359.810 / 370.967 | 96.99% | nodes 2/2 |

全帯のWASM固定深さ比が90%以上で、集計も96.58%のためGate 1合格。
160k層は全局面でノード上限へ到達し、最長のcandidate反復合計も約2.03秒（8局面合計）である。

## 計測専用WASM API

`benchmark_pattern_eval`のfeature条件付き化は今回見送った。これは計測入口を通常WASM APIから
除くためにapp側のWASMビルド条件も新設する変更となり、redoの計測・回帰補強範囲を超えるため。
既定解析結果には影響せず、将来API面を整理する際の検討事項とする。

## 再現コマンド

```text
cargo test -p engine
cargo test -p engine --release --test eval_features_nps_bench stratified_corpus_cost_is_reported -- --nocapture
cargo test -p engine --release --test pattern_eval_nps_bench -- --nocapture
cargo test -p engine --release --test ffo_bench -- --nocapture
cargo run -p engine --release --bin eval_cli -- make-zero-feature-model --pattern-weights train/weights/pattern_v4.bin --output <temp>/zero-features.pwv4
node bench/edax-compare/t158a_engine_cost_bench.mjs train/weights/pattern_v4.bin <temp>/zero-features.pwv4
```

WASMは前回T158aで生成済みのrelease artifactを使用した。redoでは本番コードを変更しておらず、
変更はテスト・corpus・ベンチスクリプトだけである。
