---
id: T164
title: canonical学習の配線(トレーナー対応+B3スカラー対応+前段修正) — 重大バグ修正(2/3)
status: todo
assignee: implementer
attempts: 0
---

# T164: canonical学習の配線

## 目的

T163で導入したD4 canonicalスキーム(PWV5)で**実際に学習できる状態**を作る。次タスクT165で「WTHOR×v4構成」「Egaroucid全量×v4構成」「Egaroucid全量×B3構成」の3構成をcanonicalで再学習し、T166の対局ゲートで現行本番v4と対決させる計画の配線部分。

## 前段修正(最初にやる、T163レビュー中2件+T159b申し送り)

1. **[T163レビュー中1] シリアライズのスキームガード**: `to_bytes`/`to_bytes_v3`(レガシー形式書き出し)がcanonicalモデルを黙って受け付けてスキーム情報が静かに失われる経路を塞ぐ(明示エラー化+テスト)。
2. **[T163レビュー中2] 記述訂正**: 「隅5x2をカバー」という作業ログ・テストコメントの誤り(PatternConfig::V3はcorner5x2を含まない)を訂正。ついでにcorner5x2形状を含む性質テストを1本追加できるなら追加(安定化群自明のため理論上自明成立だが、カバレッジの記述と実態を一致させる)。
3. **[T159b申し送り] t158系config+--simple-corpusの併用ガード解除**: B3構成をEgaroucidデータで学習できるようにする(identity・分布統計等の追従込み。B3のスカラー特徴勾配がsimple-corpusサンプルで正しく動くこと)。

## 要件

1. **v4構成のcanonical学習対応**: train_patterns_v3のv4構成(61段)を`--canonical`フラグ(名称は任意、opt-in)でcanonicalスキーム学習できるようにする。WTHOR経路・simple-corpus経路の両方で、早期打ち切り(T159/T159b)と併用可能に。出力はPWV5。既存(非canonical)経路は完全不変(識別文字列・重みビット一致の担保、方式は前例どおり)。
2. **B3構成のcanonical対応**: canonical+スカラー特徴の重み形式を追加する(PWV4がPWV3を拡張したのと同型の拡張。例: PWV6=PWV5+scalarブロック、またはPWV5にkindフィールド。T158a/bの実装を流用)。エンジン側read/score+train側学習の両方。**B3のスカラー特徴は盤面の対称変換に対して不変(モビリティ差・囲い度差は対称不変量)であることを性質テストで確認**(canonical+スカラーでも全8対称一致が成立すること)。
3. **性質テストの拡張**: 新形式(canonical+scalar)でも全8対称の評価値完全一致テスト。学習後の重みでも成立すること。
4. **スモーク**: (a)WTHOR 180k×v4-canonical早期打ち切り学習1回 (b)Egaroucidサブセット×v4-canonical 1回 (c)Egaroucidサブセット×B3-canonical 1回。各々の完走・決定性(同一コマンド再実行で重みSHA一致)・全8対称一致(学習済み重みで)を確認し、所要時間を記録。
5. `cargo test -p engine` `cargo test -p train` 全パス。

## スコープ外

- 全量本学習(T165)・対局ゲート(T166)・本番配線
- レガシースキーム削除・WASM側の変更

## 受け入れ基準

1. 両パッケージ全テストパス(新規テスト込み)
2. 既存経路(非canonical学習・レガシー重み評価)の不変実証(小規模スモークSHA一致、前例方式)が作業ログにある
3. スモーク3種の完走・決定性・学習済み重みでの全8対称一致の記録がある
4. 前段修正3件の完了(ガードのテスト・記述訂正・B3×simple-corpus動作)
5. 完了時 `git status --short` クリーン(パス明示コミット、`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 学習スモーク中は他の重い処理と並行しない。detached+ツール呼び出しポーリング、Monitor通知依存禁止。作業ログ節目追記

## 作業ログ

- 2026-07-21 前段修正+要件1/2/3実装完了(implementer、T163からの続き)
  - **前段修正(a、T163レビュー中1)**: `engine/src/pattern_eval.rs`の
    `to_bytes`(PWV2)・`to_bytes_v3`(PWV3)・`to_bytes_v4`(PWV4)に
    `assert!(self.canonical_tables.is_none(), ...)`ガードを追加(明示panic)。
    要求は`to_bytes`/`to_bytes_v3`のみだったが、`to_bytes_v4`も同じ「canonical
    モデルをレガシー形式で黙って書き出すとスキーム情報が失われる」バグ類型
    であり、本タスクで新設する`to_bytes_v6`(canonical+scalar)との対比が
    自然に成立するため、対称的にガードを追加した(スコープ拡張理由を記録)。
    `#[should_panic]`テスト4件追加。
  - **前段修正(b、T163レビュー中2)**: `PatternConfig::V3`はcorner5x2を
    含まない(edge2x+対角オフセット5-6-7のみ)という誤記を、T163の性質テスト
    コメント(`t163_canonical_score_is_invariant_for_v3_pattern_shapes_...`)と
    本タスクファイルの記述で訂正。加えて`PatternConfig::V2Corner5x2`を使った
    新規テスト`t164_canonical_score_is_invariant_for_corner5x2_pattern_shape`
    (80局面×全8対称)を追加し、カバレッジの記述と実態を一致させた。
  - **前段修正(c、T159b申し送り)**: `train/src/bin/train_patterns_v3.rs`の
    「T158 configs require the WTHOR game split」ガード(t158系config+
    `--simple-corpus`併用禁止)を解除。`run_config_seed`/`run_config_seed_early_stop`/
    `run_config_seed_early_stop_simple`は元々`config.t158`を見て
    `write_t158_metrics`(`frozen_games`空sliceでも動く)を呼ぶ共通設計だった
    ため、ガードを外すだけで機構的には動く状態だったが、以下2点を追加で
    追従させた: (1) simple-corpus経路(早期打ち切りON/OFF両方)にも、WTHOR
    経路と同じ`write_feature_distribution`(モビリティ・囲い度の分布統計)を
    t158config使用時に書き出すよう追加。(2) simple-corpus経路のidentity
    文字列に、WTHOR経路と同じ`feature_schema`(scalar kind名・scale)を
    t158config時に追加(コード側でscale_shift定義が変わった場合の検知漏れを
    防ぐ)。新規テスト
    `b3_canonical_config_now_works_with_simple_corpus_matches_direct_training_bit_for_bit`
    で、t158-b3+simple-corpusの学習が直接`Model::new_with_scalar_features_canonical`
    呼び出しとPWV6バイナリ完全一致することを確認(metrics.json出力も確認)。

  - **要件1(v4構成のcanonical学習対応)**: `TrainingConfig`に`canonical: bool`
    フィールドを追加(既定`false`、`parse_config`は常にfalseを返す)。`main`で
    `--canonical`(値なしフラグ、opt-in、`--configs`全体への一括適用)を追加し、
    `TrainingConfig{canonical, ..config}`で全configへ反映。新規ヘルパー
    `build_model(config)`(`config.canonical`で`Model::new_with_scalar_features`/
    `new_with_scalar_features_canonical`を分岐)・`serialize_model(&model, config)`
    (`(canonical, scalar_features.is_empty())`の4通りでto_bytes_v3/v4/v5/v6を
    分岐)・`run_name(config)`(`-canonical`サフィックス付きの実行名、同一
    `--output-dir`でのレガシー/canonical成果物衝突を防ぐ。`config_name`は
    表示・メトリクス用の素の名前のまま維持)を追加し、3箇所の
    `Model::new_with_scalar_features`直呼び出しと6箇所の
    `if scalar_features.is_empty(){v3}else{v4}`分岐を全てこれらのヘルパー
    経由に置き換えた。WTHOR/simple-corpus×早期打ち切りON/OFFの4経路全てに
    適用。4箇所のidentity文字列に`canonical={config.canonical}`を追加(既存
    フィールドの前後関係は変えず追記のみ)。
  - **要件2(B3構成のcanonical対応)**: `engine/src/pattern_eval.rs`に新形式
    `PWV6`(canonical+scalar)を追加。実装は「PWV4がPWV3を拡張したのと同型」
    という設計方針どおり: `to_bytes_v4`/`to_bytes_v6`は共通ヘルパー
    `to_bytes_scalar_extended(magic, version)`に、`from_bytes_v4`/`from_bytes_v6`は
    共通ヘルパー`from_bytes_scalar_extended(bytes, expected_version, format_label,
    canonical)`に統合(バイト列レイアウトはv4/v6で完全に同一、
    `schema_hash_v4`もそのまま共用——canonicalかどうかは状態インデックスの
    解釈〈スコアリング時の`table_index`〉の問題であり、シリアライズされる
    パターン形状・クラス構造そのものには影響しないため)。`from_bytes_scalar_extended`
    は内部でパターン部分を合成PWV3(canonical=false)または合成PWV5
    (canonical=true)として`from_bytes_v3`/`from_bytes_v5`に委譲し、後者は
    `canonical_tables`を自動的に埋める。`train/src/regression.rs`に
    `Model::new_with_scalar_features_canonical`・`Model::to_bytes_v6`を追加。
  - **要件3(性質テストの拡張)**: `engine/src/pattern_eval.rs`に
    `t164_canonical_scalar_score_is_invariant_under_all_eight_d4_symmetries`
    (150局面×全8対称、canonical+scalar同時)、PWV6往復テスト
    (`t164_pwv6_roundtrip_preserves_canonical_scheme_scalar_features_and_scores`)、
    schema hash不正検知テスト、PWV4誤読防止テストを追加。`train/src/regression.rs`
    に`b3_canonical_predictions_stay_d4_invariant_after_training_on_asymmetric_samples`
    (SGD学習後の重みでも全8対称一致、30局面×20epoch)を追加(T163の
    canonical版と対をなすB3版)。

  - **テスト結果**: `cargo test -p engine`: 233 passed, 2 ignored(release専用、
    無変更)。`cargo test -p train`: 105+18+10+5+1=139 passed。両方0 failed。

  - **既存経路(非canonical・レガシー重み評価)の不変実証(受け入れ基準2)**:
    `git stash push -- engine/src/pattern_eval.rs train/src/bin/train_patterns_v3.rs
    train/src/regression.rs`でT164差分を一時的に退避(T163コミット時点の
    状態に戻す)、`--release`ビルドして`train_patterns_v3.exe --configs v3
    --seeds 1 --epochs 2 --max-games 60 --output-dir <tmp>`を実行しSHA-256を
    記録(`dc18cf8f0b5902600d6e04a3eb17936e6fa411b57e9179e002ead31f7e011dd3`)。
    `git stash pop`で本タスクの差分を復元し、`--release`で再ビルド、
    **全く同じコマンドを再実行して同一のSHA-256(完全一致)を確認**。
    レガシー(非canonical)経路の出力バイナリが本タスクの変更前後でビット
    単位で不変であることを実証した。

  - 次: 要件4のスモーク3種((a)WTHOR 180k×v4-canonical早期打ち切り
    (b)Egaroucidサブセット×v4-canonical (c)Egaroucidサブセット×B3-canonical)
    を実行し、完走・決定性(同一コマンド再実行でSHA一致)・全8対称一致・
    所要時間を記録する。

- 2026-07-21 要件4: スモーク3種完了(implementer)
  - **検証方法**: `engine/tests/t164_smoke_check.rs`という使い捨てテスト
    (環境変数`T164_SMOKE_WEIGHTS_PATH`で指定した実際の重みファイルを読み込み、
    `is_canonical()`・`has_scalar_features()`、および自己対戦20局・1234局面
    ×全8対称でのscore完全一致を検証)を一時的に作成して各スモークの成果物を
    検証し、**検証後にファイルを削除した**(恒久的な回帰テストではなく
    T164完了時点の一回限りの検収ツールであるため、`tasks/`同様コミットには
    含めない。恒久的な性質テストは既にT163/T164本編で`pattern_eval.rs`/
    `regression.rs`に追加済み)。学習は他の重い処理と重ならない専有状態
    (foregroundで1本ずつ順次実行、detached/Monitor通知には依存しない)で
    実行した。出力先は全て`/tmp`(リポジトリ外、検証後に削除済み)。
  - **(a) WTHOR 180k×v4-canonical早期打ち切り**:
    コマンド`train_patterns_v3.exe --configs v4 --canonical --early-stop
    --seeds 1 --train-subset-size 180000 --output-dir <dir>`
    (train_samples=179,974、既定early-stop設定: val_percent=5%,
    patience=3, max_epochs=20)。
    - 完走: best_epoch=4, epochs_run=7(patience到達)で正常終了、
      frozen_mae=16.899275、出力27,986,340 bytes、マジック`PWV5`。
    - 決定性: 同一コマンドを別ディレクトリへ2回実行し、最終`.bin`の
      SHA-256が完全一致(`dab906e0a3bdff3f5e1d962f20dc9df868e531c724f9f56f04b081c1fc8d3c7f`)。
    - 全8対称一致: 実際に学習済みの重みで自己対戦1234局面×全8対称、
      完全一致(誤差<1e-2)。
    - 所要時間: 約6.1秒/回(データ読み込み74,024局+7エポック学習)。
  - **(b) Egaroucidサブセット×v4-canonical早期打ち切り**:
    コマンド`train_patterns_v3.exe --configs v4 --canonical --early-stop
    --seeds 1 --simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17
    --simple-max-records 30000 --output-dir <dir>`(reservoir_seed=42で
    25,514,097行から30,000件抽出、train=24,863/val=1,317/frozen=3,820)。
    - 完走: best_epoch=10, epochs_run=13(patience到達)、
      frozen_mae=10.005717、マジック`PWV5`。
    - 決定性: SHA-256完全一致(`29fa9e9e45807951e8ca4c07f6a31e8f76ae433b07254028afe9ca14dd9f7a7b`)。
    - 全8対称一致: 1234局面×全8対称、完全一致。
    - 所要時間: 約6.4〜8.1秒/回。
  - **(c) Egaroucidサブセット×B3-canonical早期打ち切り**(前段修正(c)の
    ガード解除が実際に機能することの最終確認):
    コマンド`train_patterns_v3.exe --configs t158-b3 --canonical --early-stop
    --seeds 1 --simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17
    --simple-max-records 30000 --output-dir <dir>`(同一プール、train=24,863)。
    - 完走: **T159bまでは完全にブロックされていた組み合わせが正常終了**
      (best_epoch=10, epochs_run=13, frozen_mae=8.831695, マジック`PWV6`)。
      `feature-distribution.json`(モビリティ・囲い度の分布統計)と
      `t158-b3-canonical-seed-1-earlystop.metrics.json`
      (`"frozen_games": 0`——simple-corpusには対局概念が無いため0件が正しい
      挙動、クラッシュではない)が両方とも正しく生成されることを確認。
    - 決定性: SHA-256完全一致(`639b3c65b5584ca163c7edde1625ef0bf9758e6ccc25fa7624b8fe4079af5c50`)。
    - 全8対称一致: `is_canonical=true`・`has_scalar_features=true`の
      学習済み重みで1234局面×全8対称、完全一致(scalar特徴込みでも
      canonical化が壊れていないことの最終確認)。
    - 所要時間: 約7.0秒/回。

  - **受け入れ基準の充足状況**: 1(両パッケージ全テストパス)✓、2(既存経路
    不変実証、stashベースSHA一致)✓、3(スモーク3種の完走・決定性・全8対称
    一致の記録)✓、4(前段修正3件完了)✓、5(`git status --short`クリーン、
    後述)✓。
