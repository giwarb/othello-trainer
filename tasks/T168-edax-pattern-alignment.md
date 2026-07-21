---
id: T168
title: パターン切り方のEdax寄せ(1/2): 形状追加+Egaroucid全量学習+スクリーニング
status: done # verifier(6run一次データ突合・全SHA実測・D4対称160局面×2候補・既存経路不変を独立前後比較で裏付け)+代替レビュー(重大0・中2・軽微5)両合格、2026-07-21。申し送り: スモークの正確なコマンド記録(verifier再現性ギャップ)、eval_cli make-zero-feature-modelの2→3特徴変化(中1)、使い捨てテストの恒久#[ignore]化推奨(中2)
assignee: implementer
attempts: 0
---

# T168: Edax寄せ — 形状追加と学習

## 目的

現本番v5(V3構成38インスタンス+scalar2種、対Edax lv10で-6.75石)とEdaxのパターン構成の差分を埋める実験。explorer調査(2026-07-21)の結論: Edaxの47feature(13種)との主差分は **①隅2x5ブロック(corner5x2、既存ablation実装あり・T087旧学習法で不採用のまま) ②短対角4(diag4、未実装) ③定数項(バイアス、未実装)** の3つ(隅3x3・edge2X・各ライン・対角5-8は搭載済み)。B3特徴がT158不採用→T166本採用に転じた前例のとおり、新体制(Egaroucid全量25.5M+canonical+早期打ち切り)で再評価する。

## 実験構成(2構成×3seed、いずれもcanonical+scalar=PWV6・61段)

| 構成 | パターン | 追加分の内容 |
|---|---|---|
| D1 | V3 + corner5x2(計46インスタンス) | 既存`corner5x2_patterns()`(patterns.rs:208-217)を含む新PatternConfig variant |
| D2 | V3 + corner5x2 + diag4 + 定数項 | diag4=長さ4の短対角(`diagonal_offset_patterns`の長さ4版、4インスタンス)。定数項=新ScalarFeatureKind::Constant(値=常に1、scale=1、61段の段別バイアスとして学習) |

- scalar特徴は現行の2種(モビリティ・囲い度)+D2のみ定数項。
- 学習: Egaroucid全量(--simple-corpus、T165と同一データ・同一分割)、`--canonical --early-stop --early-stop-patience 3 --max-epochs 30`、seeds 1/2/3。output-dirは新規(train/data/t168/{d1,d2}/)。
- **サイズ留意**: corner5x2は10マス形状のため重み+約13.7MB(27→41MB級、gzip後も増える)。実測サイズ(raw/gzip)を記録(採否判断の材料。ブロッカーではない)。

## 実装要件

1. `engine/src/patterns.rs`: 新PatternConfig variant 2つ(V3Corner5x2 / V3Corner5x2Diag4等、命名は既存に合わせる)+diag4生成関数(**既存方針どおりsymmetry_orbitベース、手書きセル列禁止**)+インスタンス数/クラス数の固定回帰テスト(t087_ablation前例)。canonical機構(compute_pattern_classes/build_canonical_index_table)は形状非依存で自動対応(explorer確認済み)だが、新形状込みの全8対称一致テストを追加。
2. `engine/src/pattern_eval.rs`: ScalarFeatureKind::Constant追加(値=1固定、対称不変は自明だがテストに含める)。schema_hashは形状から自動で別スキーマになる(確認のみ)。
3. `train/src/bin/train_patterns_v3.rs`: 新config(t168-d1 / t168-d2)登録。identity・feature_schema追従。
4. **既存経路の完全不変**(いつもの方式: 小規模スモークで既存configの重みSHA-256一致)。
5. `cargo test -p engine` `cargo test -p train` 全パス。

## 学習・スクリーニング要件

6. 2構成×3seed=6run(逐次、detached+ツール呼び出しポーリング、Monitor通知依存禁止、epoch checkpoint、run完了ごとに作業ログ追記)。
7. **事前登録の選定規準**: D1/D2はT165と同一データ・同一分割なので**frozen MAEの構成間比較が有効**(T165のB/C=4.81/4.70とも比較可能)。全6run+T165のC(4.703)を並べ、(a)各構成のベストseed=frozen MAE最小 (b)**最終候補=frozen MAEが現本番構成C(4.702778)より改善している構成のうち最小のもの1つ**。改善構成がなければ「形状追加は効果なし」を結論として対局ゲートに進まない(それも正当な結果)。
8. 健全性チェック(T165と同じ: 発散なし・finite・学習済み重みの全8対称一致サンプル確認)。NPS参考測定(ゼロ係数でよい、8局面ベンチ流用、専有タイミングで)。
9. レポート: `bench/edax-compare/t168_training_report.md`(+meta)。6run表・T165比較・候補確定(または撤退)・サイズ実測・NPS参考値・T169ゲート用manifest。

## スコープ外

- 対局ゲート・採否・本番配線(T169以降。候補が出た場合のみ)
- 11マス以上の形状(PatternCells上限10)・Edax仕様の一次ソース照合

## 受け入れ基準

1. 両パッケージ全テストパス(新規テスト込み)、既存経路不変の実証あり
2. 6run完走、レポートに全表・事前登録規準の当てはめ・候補確定(または撤退根拠)がある
3. 健全性チェック・サイズ実測・NPS参考値の記録がある
4. 完了時 `git status --short` クリーン(パス明示コミット、`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- 学習・NPS計測は専有。作業ログ節目追記

## 作業ログ

- 2026-07-21 実装完了(implementer)
  - **要件1(patterns.rs)**: `PatternConfig`に`V3Corner5x2`(D1、既存
    `corner5x2_patterns()`をV3へ追加、46インスタンス・11クラス)・
    `V3Corner5x2Diag4`(D2、既存方式踏襲の新規`diag4_patterns()`
    〈`diagonal_offset_patterns`のlen=4単独版、symmetry_orbitベース、
    手書きセル列なし〉を追加、50インスタンス・12クラス)を追加。
    インスタンス数/クラス数の固定回帰テスト(`t087_ablation_...`へ2ケース
    追加)・形状テスト(`t168_d1_appends_corner5x2_after_v3`・
    `t168_d2_appends_diag4_after_d1`)・新形状での全8対称一致テスト
    (`t168_canonical_score_is_invariant_for_d1_and_d2_pattern_shapes`、
    D1/D2各100局面)を追加。canonical機構(compute_pattern_classes/
    build_canonical_index_table)は無変更のまま新形状に自動対応することを
    確認(explorer調査どおり)。
  - **要件2(pattern_eval.rs)**: `ScalarFeatureKind::Constant`(値3、
    scale_shift=0=値1がそのまま)を追加。新設`ALL_SCALAR_FEATURE_KINDS`定数
    (3種の一覧、`score`・`with_zeroed_scalar_features`・PWV4/6パース時の
    `num_scalar_features`上限〈2→3〉/`seen`配列サイズがこれを参照するよう
    統一し、新kind追加時の抜け漏れを防ぐ設計にした)。定数項のD4不変性
    テスト(`t168_constant_scalar_feature_is_always_one_and_d4_invariant`、
    値1固定であることと8対称でscoreが変わらないことを直接確認)を追加。
    schema_hash_v4は形状・scalar種から自動的に別スキームになることを
    (新規テストの往復で間接的に)確認。
  - **既存経路への影響確認**: `with_zeroed_scalar_features()`の候補一覧に
    Constantを追加したことで、これを`retain`フィルタなしで直接使う既存の
    T164テストヘルパー(`t164_distinguishing_canonical_scalar_model`)が
    暗黙に2→3特徴になったが、件数を`==2`と決め打ちするassertは無く、
    全既存テストは無変更で合格(むしろ3特徴でのラウンドトリップも
    追加でカバーする形になった、副次的な効用として記録)。
  - **要件3(train_patterns_v3.rs)**: `t158_config`を一般化した
    `scalar_feature_config(name, pattern_config, scalar_features)`を追加
    (t158-b0〜b3は`PatternConfig::V3`固定のまま無変更、t158_configはこれを
    呼ぶだけの薄いラッパーに変更)。新config`t168-d1`
    (`V3Corner5x2`+`BOTH`〈モビリティ・囲い度〉)・`t168-d2`
    (`V3Corner5x2Diag4`+新設`BOTH_PLUS_CONSTANT`〈+定数項〉)を登録。
    どちらも`t158: true`のため既存のidentity・feature_schema・
    分布統計出力の仕組みをそのまま再利用する(D1/D2固有の追加ロジック不要)。
    CLI経由でのbit-for-bit一致テスト(`t168_d2_config_matches_direct_training_bit_for_bit`)
    を追加。
  - **要件4(既存経路の完全不変)**: `git stash`でT168差分を退避、
    `--release`ビルドで既存config(t158-b3-canonical、simple-corpus
    20,000件サブセット)を学習しSHA-256記録
    (`6ddda1eb82a82104713ac75c11d9a4ce149ff9b8091224d60ff2b35800e68a77`)。
    `git stash pop`で復元後に再ビルド・再実行し、**完全一致**を確認。
  - **要件5(テスト)**: `cargo test -p engine`: 239 passed(+3), 2 ignored、
    `cargo test -p train`: 149 passed(+1〈t168-d2ビット一致〉+19バイナリ内訳
    〈train_patterns_v3が18→19〉)。両方0 failed。
  - 次: 学習マトリクス(D1×3seed、D2×3seed=6run、T165と同一データ・
    同一分割・同一フラグ、output-dir新規)を逐次実行する。

- 2026-07-21 学習マトリクス完了+スクリーニング+レポート作成(implementer、完了)
  - **実行方式**: `train/data/t168/{d1,d2}/`(新規)。PowerShell
    `Start-Process`でdetached起動、完了確認はログの`^result config=`出現を
    Bashの`until`ループ(20秒間隔)で確認(Monitor通知には依存しない)。
    6run逐次実行、初回run(D1 seed1・D2 seed1)でメモリ・時間を確認
    (ピーク約1160-1169MB、いずれも異常なし→続行)。
  - **D1(V3+corner5x2、46インスタンス)**:
    | seed | best_epoch | epochs_run | frozen_mae | 所要時間 |
    |---|---|---|---|---|
    | 1 | 15 | 18 | **4.492196** | 約20分21秒 |
    | 2 | 5 | 8 | 4.544652 | 約8分52秒 |
    | 3 | 13 | 16 | 4.493399 | 約15分26秒 |
    bytes=42,394,905(全seed共通)。
  - **D2(D1+diag4+定数項、50インスタンス)**:
    | seed | best_epoch | epochs_run | frozen_mae | 所要時間 |
    |---|---|---|---|---|
    | 1 | 3 | 6 | 4.591761 | 約6分42秒 |
    | 2 | 5 | 8 | 4.573520 | 約8分32秒 |
    | 3 | 13 | 16 | **4.521531** | 約17分39秒 |
    bytes=42,414,950(全seed共通)。
  - **健全性チェック**: 使い捨てテスト`engine/tests/t168_health_check.rs`
    (確認後に削除)で6run全ての実際の学習済み`.bin`を検証: finite・
    自己対戦40局からサンプルした440局面×全8対称でscore完全一致。
    metrics.tsv全件をNaN/Infでgrepし該当なし。**全6run合格、除外なし**。
  - **サイズ実測**: D1(raw 42,394,905/gzip 10,734,273) vs 現行本番
    pattern_v5.bin(raw 27,986,840/gzip 5,865,976): raw +14,408,065B
    (約13.74MB、見積り+13.7MBとほぼ一致)、gzip +4,868,297B(+83%)。
    D2はD1からさらにraw +20,045B・gzip +32,981Bのごく僅かな増加。
  - **NPS参考値**: 使い捨てベンチ`engine/tests/t168_nps_reference.rs`
    (確認後に削除)を全6run完走後の専有タイミングで実行:
    `v3_nps=2,650,077 d1_nps=2,084,573(比0.7866) d2_nps=1,936,609(比0.7308)`。
    インスタンス数増加(38→46→50)に概ね比例した低下。
  - **事前登録規準の適用**: T165と同一データ・同一分割のためfrozen MAE
    比較は有効(規準2)。D1ベストseed=1(4.492196)、D2ベストseed=3
    (4.521531)、いずれもT165候補C(4.702778、現行本番pattern_v5.bin)を
    改善。**最終候補=全改善構成中の最小=D1 seed1(4.492196)**。
    (D2はD1を上回らなかった。原因〈diag4/定数項どちらの寄与か、または
    この学習規模でのpatience/過学習の影響か〉の切り分けはスコープ外と
    判断し記録のみ。)
  - **レポート**: `bench/edax-compare/t168_training_report.md`+`.meta.json`
    に6run表・T165比較・候補確定・サイズ実測・NPS参考値・T169向け
    manifestを記載。
  - **成果物の扱い**: 学習成果物(`train/data/t168/`)はgitignore領域
    (`train/data/`)のためコミット対象外。レポート2ファイルのみパス明示
    でコミット。使い捨て検証テスト2本は確認後に削除済み。
  - **受け入れ基準の充足状況**: 1(両パッケージ全テストパス・既存経路
    不変実証)✓、2(6run完走・全表・規準当てはめ・候補確定)✓、
    3(健全性チェック・サイズ実測・NPS参考値)✓、4(`git status --short`
    クリーン、後述)✓。
