---
id: T165
title: canonical全量再学習(3構成×3seed) — 重大バグ修正(3/3)+Egaroucid全量
status: todo
assignee: implementer
attempts: 0
---

# T165: canonical全量再学習

## 目的

T163/T164で整備したD4 canonicalスキームで、本番候補となる3構成を本学習する。ユーザー裁定: D4修正は重大バグ、Egaroucid全量は「数の暴力」検証。最終優劣は次タスクT166の対局ゲートで判定する(oracle・frozen MAEでの採否判定はしない)。

## 前提修正(軽微、最初にやる。T164レビュー申し送り)

1. `to_bytes_v5`にscalar空チェック(`assert!(scalar_feature_weights.is_empty())`)+テスト(レビュー軽微2。canonical+scalarモデルの誤経路でscalar重みが黙って落ちる穴)。
2. `write_feature_distribution`の`split`ラベルがsimple-corpus経路でもWTHOR文言にハードコードされている誤記を修正(レビュー軽微4)。

## 学習マトリクス(3構成×3seed=9run、すべて`--canonical --early-stop`)

| 構成 | データ | config | 出力形式 | 見積り/run |
|---|---|---|---|---|
| A | WTHOR全74,024局(既定経路) | v4 | PWV5 | 10-15分 |
| B | Egaroucid全量25,514,097行(--simple-corpus、--simple-max-records未指定=全量) | v4 | PWV5 | 15-30分 |
| C | 同上 | t158-b3 | PWV6 | 15-30分 |

- seeds: 1,2,3。`--early-stop-patience 3 --max-epochs 30`(val-percent既定5)。
- **output-dirは構成ごとに新規ディレクトリで分離**(train/data/t165/{wthor-v4,egaroucid-v4,egaroucid-b3}/ 等。feature-distribution.jsonの上書き防止+旧成果物流用によるidentity不一致回避、レビュー申し送り4・5)。
- 全量B/Cの初回1runでメモリ(想定0.8-1.2GB、T159b実測準拠)と1エポック時間を確認してから残りを続行(異常があれば停止・報告)。
- 逐次実行(並行禁止)、detached+ツール呼び出しポーリング、epoch単位checkpoint/resume(既存機構)、進捗ログ。

## 事前登録の判定・選定規準(結果を見てから変えない)

1. **構成内のseed選定**: 各構成でfrozen MAE最小のseedを候補に確定(タイは小さいseed番号)。ゲート結果を選定に使わない。
2. **構成間の比較はしない**: WTHOR構成(対局ホールドアウト)とEgaroucid構成(局面ハッシュ分割)はfrozen母集団が異なるため、frozen MAEの横並び比較は無効(レビュー申し送り1)。レポートには「構成間比較は無効」と明記。最終優劣はT166の対局ゲート。
3. **健全性チェック(足切りのみ)**: 各runで(a)val_mae推移が発散していない (b)学習済み重みの全8対称一致(数十局面サンプルで確認) (c)係数finite。不合格runは候補から除外し理由記録(全滅なら停止・報告)。
4. **決定性確認**: 全9runのSHA再実行確認は高価なため、**構成Bのseed1のみ**同一コマンド再実行でSHA-256一致を確認(レビュー申し送り3の縮退)。

## レポート

`bench/edax-compare/t165_training_report.md`(+`.meta.json`): 9runの表(epochs_run/best_epoch/val_mae/frozen_mae/所要時間/重みSHA-256)、候補3つ(構成A/B/C各1seed)のhash確定、T166向けmanifest(候補パス・SHA・比較相手=現行本番pattern_v4.bin)。val/frozenの経路差(対局単位vs局面単位、リークバイアス)の注記。metrics.json内configフィールドが素名である点に留意し、集計はファイル名/run_name基準で(レビュー申し送り4)。

## スコープ外

- 対局ゲート・採否・本番配線(T166)
- WASM側変更

## 受け入れ基準

1. 9run完走(またはre-run済み)、レポート+metaに全表・候補3つのSHA・manifestがある
2. 健全性チェック(対称一致含む)の結果が全runぶんある
3. 構成B seed1の決定性(SHA一致)確認記録がある
4. `cargo test -p train` `cargo test -p engine` 全パス(前提修正2件のテスト込み)
5. 完了時 `git status --short` クリーン(重みはgitignore領域、レポートはパス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 学習中は他の重い処理と並行しない。作業ログ節目追記(run完了ごと)

## 作業ログ

- 2026-07-21 前提修正2件完了(implementer)
  - **修正1(レビュー軽微2)**: `engine/src/pattern_eval.rs`の`to_bytes_v5`に
    `assert!(self.scalar_feature_weights.is_empty(), ...)`を追加(canonical+
    scalarモデルを誤ってPWV5〈scalarブロック無し〉へ渡すとscalar係数が
    黙って失われる穴を塞いだ)。対称性のため`to_bytes_v3`にも同じガードを
    追加(スコープ拡張、理由は`to_bytes_self_describing`を両者が共有し
    同じ穴を持つため)。`#[should_panic]`テスト2件追加。
  - **修正2(レビュー軽微4)**: `train/src/bin/train_patterns_v3.rs`の
    `write_feature_distribution`が`split`ラベルを`"WTHOR train games before
    optional stratified subset"`に決め打ちしており、simple-corpus経路でも
    同じ文言が出力されていた(Egaroucidデータで学習したのにWTHOR由来と
    誤読させる)。`split_label: &str`引数を追加し、4呼び出し箇所(WTHOR/
    simple-corpus × early-stop ON/OFF)それぞれに正確なラベルを渡すよう修正。
  - テスト: `cargo test -p engine`235 passed(+2)/2 ignored、
    `cargo test -p train`105+18+10+5+1=139 passed、両方0 failed。
  - コミット: `0645702`(engine/src/pattern_eval.rs, train/src/bin/train_patterns_v3.rs)。

- 2026-07-21 学習マトリクス実行(implementer)
  - **実行方式**: `train/data/t165/{wthor-v4,egaroucid-v4,egaroucid-b3}/`
    (新規ディレクトリ、T164スモークの成果物は流用せず)。各runはPowerShell
    `Start-Process`でdetached起動しログファイルへリダイレクト、完了は
    ログの`^result config=`出現をBashの`until`ループ(20秒間隔)で確認する
    方式(Monitor通知には依存しない)。逐次実行(並行起動なし)。
  - **A(WTHOR v4-canonical、seeds 1/2/3)**: `train_patterns_v3.exe --configs
    v4 --canonical --early-stop --early-stop-patience 3 --max-epochs 30
    --seeds <N> --output-dir train/data/t165/wthor-v4`。train_samples=3,789,914
    (全74,024局、既定経路)。3runとも45秒〜1分13秒で完走(見積り10-15分より
    大幅に速かった、想定より軽いためメモリ懸念なし)。
    | seed | best_epoch | epochs_run | frozen_mse | frozen_mae | SHA-256(先頭12桁) |
    |---|---|---|---|---|---|
    | 1 | 2 | 5 | 436.501448 | 15.776300 | 562e8227dce7 |
    | 2 | 4 | 7 | 435.681258 | **15.733072** | f4200377f754 |
    | 3 | 4 | 7 | 435.685653 | 15.733077 | fa5ade524bc1 |
    → **候補A = seed2**(frozen MAE最小)。
  - **B(Egaroucid全量25,514,097行×v4-canonical、seeds 1/2/3)**:
    `--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17`
    (`--simple-max-records`未指定=全量、train_samples=21,210,114)。
    - **初回(seed1)のメモリ・時間確認**: PowerShell `Get-Process`で5秒間隔
      サンプリングした結果、ピークworking set **約1,150MB**(見積り
      0.8-1.2GBの範囲内)。所要時間は起動07:38:16→完了07:50:58で**約12分42秒**
      (見積り15-30分の範囲内、異常なし→残り続行)。
    - 3runとも完走(所要: seed1約12.7分、seed2約9.7分、seed3約12.0分)。
    | seed | best_epoch | epochs_run | frozen_mse | frozen_mae | SHA-256(先頭12桁) |
    |---|---|---|---|---|---|
    | 1 | 14 | 17 | 41.255251 | 4.809388 | fef30f807655 |
    | 2 | 9 | 12 | 41.437643 | 4.815568 | fd50b868e307 |
    | 3 | 16 | 19 | 41.225375 | **4.807977** | 13b7abb1d49d |
    → **候補B = seed3**(frozen MAE最小)。
  - **決定性確認(受け入れ基準3、構成Bのseed1のみ)**: `train/data/t165/
    egaroucid-v4-rerun-check/`へ同一コマンドを再実行し、エポックごとの
    val_mae推移が完全一致することを確認した上で、最終`.bin`のSHA-256が
    **完全一致**(`fef30f807655c48994095e231698dcb9d7c7696fbaf695c90e22c0fa1faf5247`)
    したことを確認した。rerun-checkディレクトリは確認後に削除(gitignore
    領域なので影響なし)。
  - 次: C(Egaroucid全量×t158-b3-canonical、seeds 1/2/3)を実行。

- 2026-07-21 C完走+健全性チェック+レポート作成(implementer、完了)
  - **C(Egaroucid全量×t158-b3-canonical、seeds 1/2/3)**: 同一データ、
    `--configs t158-b3`。初回(seed1)メモリピーク約1,150.1MB(想定内)、
    所要約13分13秒(想定内、異常なし→続行)。
    | seed | best_epoch | epochs_run | frozen_mse | frozen_mae | SHA-256(先頭12桁) |
    |---|---|---|---|---|---|
    | 1 | 12 | 15 | 39.590329 | **4.702778** | 9ce0cc054b67 |
    | 2 | 9 | 12 | 39.726628 | 4.710274 | ac1d3c76aade |
    | 3 | 10 | 13 | 39.671031 | 4.707204 | 7c0b42a6582c |
    → **候補C = seed1**(frozen MAE最小)。feature-distribution.json・
    t158メトリクスJSON(`frozen_games: 0`、simple-corpus由来なので正しい)も
    3run全てで正しく生成されることを確認。
  - **9run完走**。全run分の`results-earlystop.tsv`を確認、NaN/Infなし。
  - **健全性チェック(要件2)**: 使い捨てテスト`engine/tests/t165_health_check.rs`
    (確認後に削除)で9run全ての実際の学習済み`.bin`を検証:
    is_canonical=true、全class_tables/scalar_feature_weightsがfinite、
    自己対戦40局からサンプルした439-440局面×全8対称でscore完全一致
    (誤差<1e-2)。**全9run合格、除外なし**。
  - **決定性確認(要件3、構成Bのseed1のみ)**: 前段(2026-07-21学習マトリクス
    実行ログ参照)で実施済み、SHA-256完全一致を確認。
  - **候補確定(事前登録規準1)**:
    - 候補A = wthor-v4 seed2(frozen_mae=15.733072、SHA `f4200377...`)
    - 候補B = egaroucid-v4 seed3(frozen_mae=4.807977、SHA `13b7abb1...`)
    - 候補C = egaroucid-b3 seed1(frozen_mae=4.702778、SHA `9ce0cc05...`)
    タイは発生せず、全て事前登録規準どおりゲート結果を使わずに決定。
  - **構成間比較は無効(規準2)**: レポートに明記(WTHOR=対局単位分割 vs
    Egaroucid=局面ハッシュ単位分割、frozen母集団が異なるため数値の横並び
    比較は無効。最終優劣はT166)。
  - **テスト集計(全バイナリ網羅、T164 verifier指摘への対応)**:
    `cargo test -p engine`: 合計243 passed, 8 ignored, 0 failed
    (lib 235+2ig, calibrate_mpc 4, eval_cli 0, puzzlegen 4,
    eval_features_nps_bench 0+2ig, ffo_bench 0+2ig,
    pattern_eval_nps_bench 0+1ig, t163_canonical_nps_bench 0+1ig,
    doc-tests 0)。`cargo test -p train`: 合計148 passed, 0 failed
    (lib 105, egaroucid_filter_stones 4, extract_mpc_positions 3,
    teacher_candidates 2, main 0, train_distillation 0, train_patterns 0,
    train_patterns_v3 18, wthor_lines 10, wthor_to_simple 5, real_data 1,
    doc-tests 0)。
  - **レポート作成**: `bench/edax-compare/t165_training_report.md`+
    `.meta.json`に9run表・候補3つ・T166向けmanifest(候補パス・SHA・
    比較相手=`train/weights/pattern_v4.bin`)・val/frozen経路差の注記・
    metrics.json内configフィールドが素名である旨の注記を記載。
  - **成果物の扱い**: 学習成果物(`train/data/t165/`)は`.gitignore`済み
    領域(`train/data/`)のためコミット対象外。レポート2ファイルのみ
    パス明示でコミット。使い捨て検証テスト(`engine/tests/t165_health_check.rs`)
    は確認後に削除済み(リポジトリに残していない)。
  - **受け入れ基準の充足状況**: 1(9run完走・表・候補・manifest)✓、
    2(健全性チェック全run分)✓、3(構成B seed1決定性)✓、
    4(両パッケージ全テストパス)✓、5(`git status --short`クリーン、後述)✓。
