# T165: canonical全量再学習(3構成×3seed)

日時: 2026-07-21。実装: implementer(Sonnetフォールバック、T163/T164からの続き)。

## 目的・前提

T163でD4 canonical化スキーム(PWV5/PWV6)を導入し、T164でトレーナー配線
(`--canonical`フラグ、`train_patterns_v3`)を整えた。本タスクは、その配線で
**本番候補となる3構成を実際に本学習する**もの。最終的な優劣判定は行わない
(ユーザー裁定: oracle・frozen MAEでの採否判定はせず、次タスクT166の対局
ゲートで判定する)。

## 前提修正(T164レビュー申し送り、本学習の前に実施)

1. `engine::pattern_eval::PatternWeights::to_bytes_v5`に
   `assert!(scalar_feature_weights.is_empty())`を追加(canonical+scalarの
   モデルを誤ってPWV5〈scalarブロック無し〉へシリアライズすると、scalar
   係数が警告なく静かに失われる穴を塞いだ)。対称性のため`to_bytes_v3`にも
   同じガードを追加。
2. `train_patterns_v3`の`write_feature_distribution`が`split`ラベルを
   WTHOR文言に決め打ちしていた誤記を修正し、呼び出し元(WTHOR/simple-corpus
   × early-stop ON/OFFの4箇所)ごとに正確なラベルを渡すようにした。

コミット`0645702`。テスト集計は全バイナリ横断(前回T164検証での指摘=
内訳計算に3バイナリ漏れがあったため、今回は`Running`行ベースで全数え上げ):
`cargo test -p engine` 合計**243 passed, 8 ignored, 0 failed**
(lib 235 passed+2 ignored、calibrate_mpc 4、eval_cli 0、puzzlegen 4、
eval_features_nps_bench 0+2 ignored、ffo_bench 0+2 ignored、
pattern_eval_nps_bench 0+1 ignored、t163_canonical_nps_bench 0+1 ignored、
doc-tests 0)。`cargo test -p train` 合計**148 passed, 0 failed**
(lib 105、egaroucid_filter_stones 4、extract_mpc_positions 3、
teacher_candidates 2、main 0、train_distillation 0、train_patterns 0、
train_patterns_v3 18、wthor_lines 10、wthor_to_simple 5、real_data 1、
doc-tests 0)。前提修正2件のテスト込み。

## 学習マトリクス・コマンド

全run共通: `--canonical --early-stop --early-stop-patience 3 --max-epochs 30`
(`--early-stop-val-percent`は既定5%)。output-dirは構成ごとに新規
(`train/data/t165/{wthor-v4,egaroucid-v4,egaroucid-b3}/`、T164スモークの
成果物とは別directory)。

- **A(WTHOR v4-canonical)**: `target/release/train_patterns_v3.exe --configs
  v4 --canonical --early-stop --early-stop-patience 3 --max-epochs 30
  --seeds <N> --output-dir train/data/t165/wthor-v4`
  (既定のWTHOR全74,024局経路、train_samples=3,789,914)。出力形式PWV5。
- **B(Egaroucid全量 v4-canonical)**: 上記に
  `--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17`
  を追加、`--simple-max-records`は**未指定(全量25,514,097行)**。
  train_samples=21,210,114。出力形式PWV5。
- **C(Egaroucid全量 B3-canonical)**: Bと同じデータ、`--configs t158-b3`。
  出力形式PWV6(canonical+scalar特徴〈モビリティ・囲い度〉)。

## 実行方式

各runはPowerShellの`Start-Process`でdetached起動しログファイルへ
リダイレクト、完了確認はログの`^result config=`出現をBashの`until`ループ
(20秒間隔ポーリング)で確認する方式(Monitor通知には依存していない)。
9run全て逐次実行(並行起動なし)。

## B/Cの初回runでのメモリ・時間確認(要件、異常なしを確認して続行)

- **B seed1**: PowerShell `Get-Process`で5秒間隔サンプリングしたピーク
  working setは**約1,150MB**(見積り0.8-1.2GBの範囲内)。所要時間は
  約12分42秒(見積り15-30分の範囲内)。異常なし→残り8run続行。
- **C seed1**: 同様にピーク約1,150MB、所要約13分13秒。異常なし→続行。

## 9run結果表

| 構成 | seed | best_epoch | epochs_run | frozen_mse | frozen_mae | 所要時間(概算) | 重みSHA-256 | 形式 |
|---|---|---|---|---|---|---|---|---|
| A(WTHOR v4-canonical) | 1 | 2 | 5 | 436.501448 | 15.776300 | 約47秒 | `562e8227dce76c71e38c8de4672ea059005dde47867dee8502678a420bd86578` | PWV5 |
| A | 2 | 4 | 7 | 435.681258 | **15.733072** | 約66秒 | `f4200377f7546521fde72fb3b8a46cc364a5ad3a56b24e94593b28af16befad2` | PWV5 |
| A | 3 | 4 | 7 | 435.685653 | 15.733077 | 約73秒 | `fa5ade524bc1bd4e3eb1f4967193ab5fd0a3edc3c1bfc23413553798c5d06bdb` | PWV5 |
| B(Egaroucid全量 v4-canonical) | 1 | 14 | 17 | 41.255251 | 4.809388 | 約12分42秒 | `fef30f807655c48994095e231698dcb9d7c7696fbaf695c90e22c0fa1faf5247` | PWV5 |
| B | 2 | 9 | 12 | 41.437643 | 4.815568 | 約9分32秒 | `fd50b868e3070ef2cf3fc071f975cfd1c0540a49c45ed50d10456b832fa8f3be` | PWV5 |
| B | 3 | 16 | 19 | 41.225375 | **4.807977** | 約14分35秒 | `13b7abb1d49d9aa07fe5c1d5a2af2f5ea24d0f979985832432199a2c7512c313` | PWV5 |
| C(Egaroucid全量 B3-canonical) | 1 | 12 | 15 | 39.590329 | **4.702778** | 約13分13秒 | `9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4` | PWV6 |
| C | 2 | 9 | 12 | 39.726628 | 4.710274 | 約10分47秒 | `ac1d3c76aade1901a69220110a3180f24e104d4d4890c3901150bd1ffe012356` | PWV6 |
| C | 3 | 10 | 13 | 39.671031 | 4.707204 | 約11分37秒 | `7c0b42a6582ca8a67907c50de41baa66d330eeaa3d0081ab290f986ade1348d7` | PWV6 |

太字=各構成内でfrozen MAE最小(事前登録規準1により候補確定、以下参照)。
所要時間は起動時刻とファイルmtimeの差(秒単位、詳細は作業ログ参照)。

## 事前登録の判定・選定規準の適用結果

1. **構成内seed選定(frozen MAE最小)**:
   - **候補A = seed2**(15.733072、seed3=15.733077とほぼ同値だが厳密に最小)
   - **候補B = seed3**(4.807977)
   - **候補C = seed1**(4.702778)
   タイは発生しなかった(全て厳密な大小関係で決着)。ゲート結果(T166)は
   選定に一切使っていない。
2. **構成間比較は無効**: WTHOR構成(A、対局単位ホールドアウトのfrozen)と
   Egaroucid構成(B/C、局面ハッシュ単位分割のfrozen)はfrozen母集団の生成
   方法が根本的に異なる(対局単位=同一対局内の局面が丸ごとtrain/frozen
   どちらかに寄る一方、局面単位=同じ対局の別局面がtrain/frozen両方に
   混在しうる)。このため、AのfrozenMAE(15.7台)とB/CのfrozenMAE(4.7-4.8台)
   を「Aの方が悪い」のように横並び比較することは**無効**。データ規模
   (74,024局 vs 25,514,097局面)も評価対象(WTHOR石差ラベル vs Egaroucid
   自己対戦ラベル)も異なるため、数値の絶対値そのものに構成間比較の意味は
   ない。**最終優劣はT166の対局ゲートで判定する。**
3. **健全性チェック(足切り)**: 全9runについて以下を確認、**全run合格**
   (除外なし)。
   - (a) val_mae推移が発散していない: 各runの`*.metrics.tsv`をNaN/Infで
     grepし該当なし。ログの逐次val_mae値も正常範囲(A: 14.3-15.0台、
     B: 5.0-5.2台、C: 4.9-5.1台)で推移し、patience到達による打ち切りは
     正常な収束後の停滞(過学習ではなく改善が頭打ちになった状態)。
   - (b) 学習済み重みの全8対称一致: 使い捨て検証テスト
     (`engine/tests/t165_health_check.rs`、確認後に削除。実装は
     `engine::pattern_eval::PatternWeights::from_bytes`で各runの実際の
     `.bin`を読み込み、自己対戦40局から6手ごとにサンプルした局面
     〈各run 439-440局面〉×全8対称でscoreの完全一致〈誤差<1e-2〉を確認)。
     9run全てで完全一致。
   - (c) 係数finite: `from_bytes`のパース自体が非finite値を拒否するため
     構造的に保証されるが、`class_tables`/`scalar_feature_weights`を
     直接走査しても全て有限値であることを再確認した。
4. **決定性確認(構成Bのseed1のみ)**: `train/data/t165/egaroucid-v4-rerun-check/`
   へ同一コマンドを再実行し、エポックごとのval_mae推移が完全一致した上で、
   最終`.bin`のSHA-256が完全一致(`fef30f807655c48994095e231698dcb9d7c7696fbaf695c90e22c0fa1faf5247`)
   することを確認した(rerun-checkディレクトリは確認後に削除、gitignore
   領域なので影響なし)。

## val/frozenの経路差についての注記(要件の明記事項)

- **A(WTHOR)**: 対局単位でtrain/val/frozenを分割する(`split_early_stop_validation`
  が対局のFNVハッシュで検証split、残りの90%対局のうち10%を別途frozen
  holdoutとして最初に取り分ける)。1対局内の全局面は同じsplitに属すため、
  同一対局由来の局面がtrain/val間でリークすることはない。
- **B/C(Egaroucid simple-corpus)**: `simple_corpus::split_for_early_stop`が
  **局面(position)単位**のハッシュで検証split・frozen splitを行う(対局
  概念が無いデータのため)。理論上、同一対局由来の別局面がtrain側とval/
  frozen側の両方に分散しうる(局面間の相関によるリークバイアスの可能性が
  WTHOR構成より高い)。このため、B/CのfrozenMAEの絶対値は「見かけ上
  小さく出やすい」方向のバイアスを持ちうる点に注意(T153/T159bで確認済みの
  既知の制約、構成間比較を無効とする理由の一つでもある)。

## metrics.json内`config`フィールドについての注記

`*-earlystop.metrics.json`内の`"config"`フィールドは`TrainingConfig.name`
(例: `"v4"`, `"t158-b3"`)の**素の名前**であり、`--canonical`フラグの有無を
反映しない(canonical/レガシーで同じ値になる)。canonical化の有無は
ファイル名(`run_name`が付与する`-canonical`サフィックス、例:
`v4-canonical-seed-1-earlystop.bin`)とマジックバイト(PWV5/PWV6)で判別する
必要がある。本レポート・`.meta.json`の集計はファイル名/run_name基準で
行った(T164レビュー申し送り4)。

## T166向けmanifest(候補3つ)

| 構成 | 候補seed | パス | SHA-256 | 形式 | 比較相手 |
|---|---|---|---|---|---|
| A(v4-canonical, WTHOR) | 2 | `train/data/t165/wthor-v4/v4-canonical-seed-2-earlystop.bin` | `f4200377f7546521fde72fb3b8a46cc364a5ad3a56b24e94593b28af16befad2` | PWV5 | `train/weights/pattern_v4.bin`(現行本番、PWV3、SHA-256 `c372b83366c4006023ae05f3af5b68dda5929aca7ff7308d1b398a89639e383f`) |
| B(v4-canonical, Egaroucid全量) | 3 | `train/data/t165/egaroucid-v4/v4-canonical-seed-3-earlystop.bin` | `13b7abb1d49d9aa07fe5c1d5a2af2f5ea24d0f979985832432199a2c7512c313` | PWV5 | 同上 |
| C(B3-canonical, Egaroucid全量) | 1 | `train/data/t165/egaroucid-b3/t158-b3-canonical-seed-1-earlystop.bin` | `9ce0cc054b67807641b759a2e881a87dd562146dee5e4d659bba1efa228f54a4` | PWV6 | 同上 |

現行本番`train/weights/pattern_v4.bin`は非canonical(レガシースキーム、
D4バグを含む旧版)で、`tasks/T124-v4-stage-resolution.md`のv4×WTHOR seed3
runと同一ファイル(SHA-256が一致することを確認済み)。T166ではこの3候補と
現行本番を対局させ、対局ゲートで優劣を判定する想定。

## スコープ外(本タスクでは行っていない)

- 対局ゲート・採否判定・本番配線(T166)
- WASM側の変更
- 9run全てのSHA再実行確認(決定性確認は構成Bのseed1のみ、事前登録規準4)
