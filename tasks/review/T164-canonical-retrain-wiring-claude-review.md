# T164 canonical学習の配線 — 最終レビュー(Claude代替、Codex usage limit中)

- 対象: コミット `93f085e`(engine/src/pattern_eval.rs +314/-?, train/src/bin/train_patterns_v3.rs +362/-?, train/src/regression.rs +209)
- 親コミット: `23ba0ff`
- レビュー方法: 差分精読 + 現行コード(to_bytes_v5/from_bytes_v5/from_bytes_self_describing/save_artifact/verify_identity/write_t158_metrics/write_feature_distribution/finalize_early_stop_result)との突き合わせ + レガシー書き出しAPIの全呼び出し箇所のgrep実測 + 下流ツール(bench/edax-compare/t158b_analyze.py)の入力確認。静的検証(テスト実行・スモーク再現はせず、作業ログの実行記録を前提。受け入れ基準コマンドの実行はverifier担当)。
- 前提: T163レビュー(tasks/review/T163-d4-canonicalization-claude-review.md)の中2件が本タスクの前段修正対象。

## 総合判定: **合格**(重大指摘なし。中1件は要件文言との乖離だが明示エラー方向の安全な逸脱であり、done判定は妨げない。T165への申し送りあり)

---

## 1. PWV6形式の設計(観点1) — 正しい

- **シリアライズ共通化**: `to_bytes_v4`/`to_bytes_v6`は`to_bytes_scalar_extended(magic, version)`に、`from_bytes_v4`/`from_bytes_v6`は`from_bytes_scalar_extended(bytes, expected_version, format_label, canonical)`に統合。バイト列レイアウトはPWV4と完全同一で、magic/version(計8バイト)のみが異なる。共通ヘルパーは`canonical_tables`を一切参照せず、canonical性の付与は読み込み側の委譲先切り替え(合成PWV3→`from_bytes_v3` / 合成PWV5→`from_bytes_v5`)だけで実現される。`from_bytes_v5`は`canonical_tables`をパターン形状から再計算して埋める(T163で決定性検証済みの方針)ため、PWV6の読み込みは構造的に「PWV4のパース+PWV5のcanonical化」の合成であり、新規のパースロジックを持たない。ドリフト防止として適切。
- **合成base_bytesのschema_hash**: `from_bytes_scalar_extended`は先に格納された`schema_hash_v4`(パターン定義・クラス・ステージ・scalarリストを網羅)を検証し、その後の合成PWV3/PWV5には再計算した`schema_hash`を埋め込む。内側のhash検査が形骸化するが、実質的な整合検証は外側の`schema_hash_v4`が担っており、これは**変更前のfrom_bytes_v4が既に採っていた方式そのまま**(canonical分岐の追加のみ)。問題なし。
- **schema_hash_v4の共用とPWV4/PWV6誤読リスク**: canonicalかどうかはhashに入らないが、`from_bytes`はmagicでディスパッチし(`b"PWV6" => from_bytes_v6`)、各パーサはversionフィールドも検査する(`from_bytes_scalar_extended`のexpected_version照合)。したがってPWV6ファイルがPWV4として読まれる(逆も)には**magicとversionの両方(8バイト)を意図的に書き換える改竄**が必要で、偶発的・プログラム的な誤読経路は存在しない。これはT163レビュー軽微6(PWV3⇔PWV5)で「既存形式群と同水準の設計」と判定したのと同一の脅威モデルであり、**脅威モデル外として妥当**。`t164_pwv4_bytes_are_read_as_legacy_even_through_the_shared_scalar_parser`が共有パーサ経由の振り分けを、`t164_pwv6_rejects_schema_hash_mismatch`がhash破壊拒否を、往復テストがcanonical+scalarの保存を直接検証しており、テストの裏付けも十分。
- `Model::new_with_scalar_features_canonical`は`zeroed_canonical` + `with_zeroed_scalar_features` + retainという既存部品の合成のみで、`new_with_scalar_features`(レガシー版)と正確に対をなす。空slice時にPWV5相当となる挙動もdocに明記され、`serialize_model`の分岐と整合。

## 2. 4経路×canonical分岐の網羅性(観点2) — 漏れなし

- **モデル構築**: `Model::new_with_scalar_features`の直呼び3箇所(run_config_seed / run_config_seed_early_stop / run_config_seed_early_stop_simple)は全て`build_model(config)`に置換。他に直呼びが残るのはテストと`t088_experiment`/`t090_distillation`(レガシー実験専用、canonical対象外)のみ(grepで確認)。
- **シリアライズ**: `if scalar_features.is_empty(){v3}else{v4}`分岐6箇所(3関数×checkpoint/best・final)は全て`serialize_model`に置換。`serialize_model`は(canonical, scalar空)の4通り→PWV3/PWV4/PWV5/PWV6を全域マッチで割り当て、到達不能な組み合わせがない。
- **run_name**: 3つのrun関数すべてが内部で`run_name(config)`を使い、run_dir・final_path・metrics.json・state.txtのファイル名が`-canonical`サフィックスで分離される。early-stop経路の`finalize_early_stop_result`にも`&name`(run_name)が渡り、results-earlystop.tsvの行も識別可能。
- **identity文字列**: `canonical={config.canonical}`は5つのフォーマット全て(schema=2 / schema=3-t158 / schema=2-simple / schema=5-earlystop / schema=6-earlystop-simple)に追加されており、**識別漏れはない**。誤ったresume再利用は「identity不一致で明示拒否」+「run_name差でそもそもパスが別」の二重に防がれる。resume時に旧checkpointから`Model::from_bytes`で復元したモデルとconfigの不整合(PWV5をcanonical=false configで続行等)も、identity検証が先に走るため到達不能。
- `--canonical`は値なしフラグ(`flag_present`、`--early-stop`と同じ機構)で全configに一括適用。未指定時は`parse_config`が常に`canonical: false`を返すため、レガシー起動のconfig構造は不変。

## 3. 前段修正の質(観点3) — 良好(1点だけ文言乖離、中1)

- **(a) to_bytes系ガード**: `to_bytes`(PWV2)/`to_bytes_v3`/`to_bytes_v4`に`canonical_tables.is_none()`のassertを追加。`to_bytes_v4`への拡張はPWV6新設との対比で妥当なスコープ拡張(理由も作業ログに記録)。`#[should_panic(expected=...)]`テスト4件は、実際に`zeroed_canonical`/canonical+scalarモデルを作って当該APIを直接呼び、パニックメッセージの部分一致まで検査しており**実効的**。既存の正常系呼び出し(t088/t090/eval_cli/train_patterns等)は全てレガシーモデル由来でassertは発火し得ないことをgrepで確認した。
- **(b) 記述訂正**: T163性質テストのコメントを「V3はcorner5x2を含まない」と訂正し、訂正経緯まで書き込んだうえで`t164_canonical_score_is_invariant_for_corner5x2_pattern_shape`(V2Corner5x2、80局面×全8対称)を追加。T163レビュー中2の「記述と実態の一致+可能ならテスト1本」を完全に満たす。
- **(c) t158×simple-corpusガード解除**: ガード削除だけでなく、(1)simple両経路(ES ON/OFF)への`write_feature_distribution`追加(configループ前に1回、train_samples全体から——複数config指定でも入力が同一なので1ファイルで正しい)、(2)identityへの`feature_schema`追加(フォーマット`"{}:/{}"`はWTHOR経路の既存コードと文字単位で同一)まで追従。ビット一致テスト`b3_canonical_config_now_works_with_simple_corpus_matches_direct_training_bit_for_bit`はCLI経路と直接`Model`学習のPWV6完全一致+metrics.json生成(frozen_games=空slice)まで検証しており、ガード解除の核心を直接押さえている。
- **frozen_games=0のmetrics出力**: `write_t158_metrics`は空sliceで`frozen_games: 0`・`game_mae: []`を出すだけでクラッシュ経路はない。既存の下流ツールは`bench/edax-compare/t158b_analyze.py`のみで、これは**固定の旧WTHOR成果物パス**(pilot/full配下のt158-*-seed-N.metrics.json)しか読まないため壊れない。ただし同スクリプトのpaired bootstrapは`game_mae`同形状を要求する(`unpaired game metrics`でraise)ので、simple-corpus由来metricsを流用した対局単位比較は**構造的に不可能**——T165申し送り1へ。
- **B3スカラー勾配のcanonical追従**: `b3_canonical_scalar_gradient_multiplies_loss_gradient_by_feature_value`(非対称盤面での勾配の解析解照合)、SGD誤差減少テスト、学習後PWV6往復、学習後D4不変(30局面×20epoch)の4本で、レガシー版テスト群と正確に対をなす。

## 4. スモーク検証方法の妥当性(観点4) — 許容(軽微5)

- 使い捨てテスト(`t164_smoke_check.rs`、環境変数で実重みを指定し、is_canonical/has_scalar_features+自己対戦1234局面×全8対称を検査、検証後削除)方式は、(i)恒久的な性質テストが同等の不変量を`pattern_eval.rs`/`regression.rs`に既に持つこと、(ii)スモークの固有価値である「実際の学習成果物の検査」はコマンド・入力データ・コード(コミット済み)・決定性SHA-256が作業ログに全て記録されており**成果物ごと再現可能**であることから、参考実証として許容できる。成果物の再現に必要な情報は失われていない。
- ただし検収ハーネス自体は失われたため、将来再検証する際は小さなハーネスの書き直しが必要になる。`#[ignore]`付きでコミットしておく方が監査性は高かった(改善提案、ブロッカーではない)。
- スモーク3種の内容自体は要件4を満たす: (a)WTHOR 180k×v4-canonical ES(PWV5、SHA一致、~6.1s)、(b)Egaroucid 30k×v4-canonical(PWV5、SHA一致)、(c)Egaroucid 30k×B3-canonical(PWV6、SHA一致、feature-distribution+metrics生成確認)。専有実行・foreground順次というコミット規律も遵守。
- 既存経路の不変実証(受け入れ基準2)のstash方式(変更前後で同一コマンド→.binのSHA-256完全一致)は前例(T163)どおりで、**重みバイナリについては**厳密。identityファイルは対象外だった点は中1参照。

## 5. run_nameとconfig_nameの整合(観点6) — 概ね妥当(軽微3)

- ファイル名・run_dir・results(-earlystop).tsvの行・コンソールログ(`result config=v4-canonical ...`)は全てrun_name(-canonical付き)で、レガシー行と混ざっても識別可能。identityは`config=素名` + `canonical=true/false`の別行で、こちらも一意。
- 唯一、**metrics.json内部の`config`フィールドだけが素名**(`write_t158_metrics`が`config.name`を書く)で、canonicalマークを持たない。ファイル名(`t158-b3-canonical-seed-1-earlystop.metrics.json`)には付くため実害は小さいが、metrics.jsonの中身だけで集計するツールはレガシー/canonical実行を混同しうる。T165では出力ディレクトリ分離またはファイル名基準の集計を推奨(申し送り4)。

## 指摘事項

### 重大(ブロッカー): なし

### 中

1. **レガシー実行のidentity文字列も変更されており、要件1の「既存(非canonical)経路は完全不変(識別文字列…の担保)」と文言上乖離**: `canonical={}`(全5フォーマット)と`feature_schema={}`(simple系2フォーマット、非t158では空文字)が**非canonical実行のidentityにも無条件で**追加されたため、レガシー実行の`.meta`(identity)はT164前後でバイト一致しない。stashベースの不変実証は`.bin`のSHAのみでidentityを検証していない。帰結: T164以前に作られたcheckpoint/最終成果物が残るoutput-dirをT164後のバイナリでresume・再実行すると、`verify_identity`が「run identity mismatch; refusing resume」で**明示的に失敗**する(静かな破損・誤再利用は起きない=安全側の逸脱)。canonical時のみフィールドを追記する設計ならレガシーidentityのバイト不変と識別性を両立できた。実害はほぼない(T165は新規実行、旧runの再開需要は現状ない)が、(i)要件との乖離と(ii)旧output-dir流用時の明示エラーという挙動変化を申し送りとして残すこと。作業ログの「追記のみ」という記述はこのresume非互換に触れておらず、不変実証の範囲(.binのみ)も明記が望ましかった。**done判定は妨げない**。

### 軽微

2. **`to_bytes_v5`にscalar空チェックがない**(T163レビュー中1後半の提案が未実装): canonical+scalarモデル(PWV6対象)を誤って`to_bytes_v5`に渡すと、PWV3レイアウト(scalarブロックなし)のためscalar重みが黙って落ちる。現状は`serialize_model`のconfig分岐+identity検証で到達不能だが、PWV6導入によりこの組み合わせのモデルが実在するようになったため、`assert!(self.scalar_feature_weights.is_empty())`の追加が対称性の面でも望ましい(`to_bytes_v3`/`to_bytes`も同類型だが、こちらはPWV4時代からの既存挙動)。
3. `write_t158_metrics`が書くmetrics.json内の`config`フィールドが素名のままcanonical識別を持たない(上記5節)。
4. `write_feature_distribution`の`split`フィールドが`"WTHOR train games before optional stratified subset"`にハードコードされたまま、simple-corpus経路(Egaroucidデータ)でも出力される。メタデータの誤記であり、simple経路ではラベルを変えるべき(実データはtrain_samples全体で統計値自体は正しい)。
5. スモーク検収ハーネス(t164_smoke_check.rs)の削除により、成果物の再検証には小さなハーネスの再作成が必要(4節のとおり許容範囲、記録は十分)。

## 6. T165(全量学習)への申し送り

1. **simple-corpus構成のfrozen評価には対局概念がない**(`frozen_games: 0`、`game_mae: []`): 対局単位のpaired bootstrap(t158b_analyze.py方式)は**Egaroucid系2構成では構造的に不可能**。構成内のseed間比較・ベスト選定は局面単位の`frozen_mae`(frozen_samplesは局面ハッシュ分割、T159b)で行う。またWTHOR構成(対局ホールドアウト)とEgaroucid構成(局面ハッシュ分割)は**frozen splitの母集団が異なるため、frozen_maeを構成間で直接横並び比較しない**こと。最終優劣はT166の対局ゲートで判定する。
2. **val splitの意味も経路で異なる**: WTHOR ESは対局単位分割、simple ESは局面単位ハッシュ分割。後者は同一進行の近傍局面がtrain/valに分かれる相関リークでval_maeが楽観的になりうる(T159b時点で既知の設計)。early-stopの停止タイミング比較・val_maeの数値解釈時に注意。
3. **25.5M行全量のメモリ・時間**: `simple_max_records`未指定なら全SampleをVecで保持する(reservoirスキップ)。Sample+分布統計用Vecでギガバイト級のワーキングセットになる見込みなので、実行前に概算確認を(必要なら--simple-max-recordsの大きい値で段階確認)。学習時間はスモーク(30kで~7s)からの外挿で1構成×1seedあたり時間オーダーの可能性があり、**長時間実行ルール(逐次checkpoint・resume・進捗ログ)は既存機構で満たされている**が、決定性確認(同一コマンド再実行SHA一致)は全量では高価なので、代表1構成のみ等の縮退を検討してよい。
4. **成果物管理**: `-canonical`サフィックスによりレガシーと同一output-dirでも衝突しないが、metrics.json内`config`フィールドは素名(軽微3)なので、集計はファイル名/results TSVの行名(run_name)基準で行う。`feature-distribution.json`はoutput-dir単位で1ファイル(config横断)なので、WTHOR構成とEgaroucid構成は**output-dirを分ける**こと(上書き防止)。
5. **旧output-dirを流用しない**(中1): T164以前の成果物が残るディレクトリで再実行するとidentity不一致の明示エラーになる。T165は新規ディレクトリで開始する。
6. 保存経路はtrainer配線(`serialize_model`)に一本化されており、canonicalモデルがレガシー形式で書かれる事故はassertで防がれる(T163申し送り1は解消済み)。B3-canonicalの成果物はPWV6であり、エンジン側`from_bytes`は対応済みだが**WASM側・本番配線はT164スコープ外**のまま——T166で対局させる際のエンジン組み込み経路(ネイティブ)では問題ないことをゲート設計時に確認すること。
