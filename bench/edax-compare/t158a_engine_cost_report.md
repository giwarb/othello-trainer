# T158a engine scalar feature cost report

計測日: 2026-07-20 (Asia/Tokyo)

## 結論

Gate 0は合格。ゼロ係数PWV4はPWV3 baselineと評価値・best move・score・depth・nodes・PVが
機械検証で完全一致した。Gate 1の主判定値であるWASM固定深さNPS比は **95.94%** で、
事前登録した90%基準を上回るため **Gate 2へ進む**。

本番相当の`maxNodes=160000`, `timeMs=1500`ではnative/WASMとも約0.31〜0.36秒で
160,000ノードへ到達し、`nodeLimitHit=true`, `timedOut=false`だった。したがってこのfixtureでは
**時間上限ではなくノード上限が支配的**である。scalar feature追加後もWASM中央値318.08msで、
時間上限まで約1.19秒の余裕がある。

## 実装・Gate 0

- 8方向シフトと整数popcountによる空きマス接触辺数primitiveを追加。
- exact mobility差は既存`legal_moves_relative`を両色について使用。
- PWV4を追加。scalar schemaはkind/scale shift/順序をhashへ含め、未知kind、重複kind、
  kind不整合scale、非0 reserved、非finite係数、stage不一致、hash不一致、余剰bytesを拒否。
- PWV1〜PWV3はscalar feature配列が空で、既存pattern加算順を変更していない。
- PWV4だけpattern和の後にkind 1→2の固定順でscalar項を加算。
- CLIに`--disable-eval-features`を追加。比較は別プロセスまたはfresh TT条件。
- 色交換で符号反転、全D4で不変、囲い度を独立8×8二重ループ実装と比較して一致。
- 現行`pattern_v4.bin`から作ったゼロ係数PWV4を40 plyのfixture列でPWV3とbit-exact比較。
- native/WASM共通fixtureの固定深さ結果: move=d6、score=11.09 disc、depth=9、nodes=183,318。
- native/WASM共通fixtureの160k結果: move=d6、score=11.09 disc、depth=9、nodes=160,000。

`cargo test -p engine`: 209 passed / 0 failed / 2 ignored（release専用ベンチのみignore）。

## Gate 1 計測条件

- release、専有状態、baseline/candidate交互順、warm-up後7反復、中央値と全範囲。
- 各探索はfresh TT 64MB、`exact_from_empties=0`（固定深さ）または本番値16（160k層）。
- baseline: `train/weights/pattern_v4.bin` (PWV3、SHA-256
  `c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`)。
- candidate: pattern本体が同一で2 scalar係数を全て0にしたPWV4 (SHA-256
  `3d4bdb7aa58ae0116983c47052230c26886a9823a981b28614eae47b397f6dd1`)。
- native: rustc 1.96.1、x86_64-pc-windows-msvc、LLVM 22.1.2。
- WASM: wasm-bindgen 0.2.126、Node v22.13.0、Windows x64。
- CPU識別子: AMD64 Family 25 Model 80 Stepping 0。OS: Windows 10.0.26200.0。
- microbenchは`std::hint::black_box`で入力とscoreを消費。ゼロ係数でもfeature計算を実行。

## 結果

比率は`baseline elapsed / candidate elapsed`。同一ノード数の探索ではNPS比に等しい。

| runtime / layer | baseline median (range) | PWV4 zero median (range) | ratio |
|---|---:|---:|---:|
| native eval 200,000回 | 69.697 ms (69.186–72.470) | 87.404 ms (86.737–90.766) | 79.74% |
| native 固定深さ d9 / 183,318 nodes | 241.307 ms (239.494–245.332) | 254.883 ms (250.972–256.522) | 94.67% |
| native 160k/1500ms | 346.551 ms (342.665–355.561) | 356.650 ms (349.167–362.222) | 97.17% |
| WASM eval 150,000回 | 58.675 ms (57.357–60.528) | 66.488 ms (63.698–71.484) | 88.25% |
| WASM 固定深さ d9 / 183,318 nodes | 215.839 ms (214.113–228.333) | 224.977 ms (221.055–230.351) | **95.94%** |
| WASM 160k/1500ms | 317.543 ms (309.088–344.044) | 318.082 ms (314.401–325.093) | 99.83% |

探索全体ではpattern抽出・探索処理が占めるため、評価単体より低下幅が小さい。

## 再現コマンド

```text
cargo test -p engine
cargo test -p engine --release --test eval_features_nps_bench -- --nocapture
cargo test -p engine --release --test pattern_eval_nps_bench -- --nocapture
cargo test -p engine --release --test ffo_bench -- --nocapture
cargo run -p engine --release --bin eval_cli -- make-zero-feature-model --pattern-weights train/weights/pattern_v4.bin --output <temp>/zero-features.pwv4
wasm-pack build engine --target web --out-dir app/src/engine/pkg
node bench/edax-compare/t158a_engine_cost_bench.mjs train/weights/pattern_v4.bin <temp>/zero-features.pwv4
```

この環境では`wasm-pack`のキャッシュ配置先がsandbox外で再インストールを拒否されたため、
同一キャッシュ版`wasm-bindgen 0.2.126`を既存release WASMへ直接適用した。生成物と実行経路は
上記`wasm-pack build --target web`相当である。
