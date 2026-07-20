---
id: T163
title: D4 canonical化(対称局面の評価値不一致の根本修正) — 重大バグ修正(1/3)
status: done # verifier(全項目+regression-catching独立追試+テスト数実態142=+5純増確認)+代替レビュー(重大0・中2・軽微4、数学的正当性を独立導出で検証)両合格、2026-07-21。中2件(to_bytesのcanonical黙殺ガード欠落・corner5x2カバー記述誤り)はT164前段で修正
assignee: implementer
attempts: 0
---

# T163: D4 canonical化(エンジン側)

## 目的

ユーザー裁定(2026-07-21、重大バグ指定): 回転・鏡映で同一になる局面の静的評価値が最大約1.45石ズレる(T044由来、T145実測、explorer調査2026-07-21で機構特定済み)。根本原因を修正し、**全8対称変換で評価値が完全一致する**評価スキームを導入する。

## 根本原因(explorer調査済み、これを前提に実装する)

`engine/src/patterns.rs` の `compute_pattern_classes`(384-432行付近)が、代表インスタンス→各インスタンスの整列変換を「8対称変換を0..7の順で走査し、セル**集合**が最初に一致したものを採用してbreak」で決めている。現行の全パターン形状(行・列・対角線・隅3x3等)は自明でない安定化群を持つ(=写し方が複数ある)ため、恣意的に選ばれた変換が実際の全域対称変換と整合せず、対称局面間で状態番号がズレる。例: a1隅→h1隅はsym=1(90度回転)とsym=4(左右反転)の両方で写るがsym=1が採用され、盤面全体の左右反転と食い違う。学習(train)も同じコードを使うため「内部では一貫、対称局面間で不一致」の性質。詳細はSTATUS・T145作業ログ・`pattern_eval.rs:1419-1492`のテストコメント参照。

## 設計方針(オーケストレーター裁定。実装上の合理的理由があれば代替案を提案してよいが、性質1・2は絶対)

**新旧共存方式**(T158a PWV4の前例に倣う):

1. **レガシースキーム完全温存**: 既存の重みファイル(pattern_v1〜v4.bin、PWV4含む)は従来どおり読み込め、**評価値はビット単位で不変**(本番アプリ・既存テスト・ベンチを壊さない。D4バグはレガシー経路では残ったままでよい)。
2. **新канonicalスキームの追加**: 新しい重み形式(スキーム識別子を持つ。例: ヘッダのschema版数繰り上げ)で読み込んだ場合のみ、D4整合の状態番号付けを使う。**性質(絶対条件): 任意の盤面とその8対称変換すべてで評価値(score関数の出力)が完全一致する。**
3. **canonical化の実装方法(推奨)**:
   - 整列変換の選択を「全域対称変換として一貫する」剰余類代表の正準規則に再設計する
   - 各パターンの安定化群(そのパターン自身を保つ変換)については、状態番号を**安定化群の像の最小値に正規化**(canonical index)する。実行時コストを避けるため、パターンセット構築時に `state_index → canonical_index` の変換テーブル(3^マス数のu32配列)を事前計算し、評価時は表引き1回追加のみとする
   - これによりテーブルの実効自由度はEdax同様に縮む(記事の例: 隅9マス 19,683→10,206)。ファイル上のテーブルサイズを縮めるか(canonical索引のみ格納)、フルサイズのまま同値エントリを共有するかは実装が単純な方を選んでよい(選択と理由を作業ログに記録)
4. **train側の追従**: `train/src/regression.rs` のSGDが新スキームでも正しく動く(勾配が canonical エントリに集約される)こと。新スキームでの学習出力は新形式で保存。既存スキームでの学習経路は不変。
5. **WASM/アプリへの影響ゼロ(本タスク時点)**: 本番はレガシーpattern_v4.binのまま。新スキームの本番採用は再学習(T164)+対局ゲート(T165)の後。

## 要件

1. **性質テスト(最重要)**: 新スキームについて (a)ランダム盤面(パスや終局近くを含む多様な局面、決定的seedで数百局面以上)×全8対称で `score` 完全一致 (b)WTHOR実局からサンプリングした実局面でも同様 (c)レガシースキームのビット不変(既存の代表値の固定テストまたは既存重みでの評価値スナップショット比較)。既存の`score_is_invariant_under_all_eight_d4_symmetries_of_the_initial_position`(現状はレガシーの制約をコメントで記録しているテスト)を新スキームでは全対称一致の実テストに昇格。
2. **决定性**: 新スキームの状態番号・canonical変換テーブルは決定的(プラットフォーム非依存のハッシュ・順序)。
3. **NPS確認**: 新スキーム(canonical表引き1回追加)のNPSがレガシー比で大きく劣化しないこと(T158aの層化8局面ベンチを流用、ゼロ係数重みでよい。目安: 95%以上。参考記録でよく、ゲートはT165の実対局で判定)。
4. **形式・拒否**: 新形式ヘッダにスキーム識別を含め、旧コード(もし旧バイナリが新ファイルを読んだ場合)や新コードの誤用で静かに混在しないこと(明示エラー)。schema-hash方式はT158a PWV4の前例に倣う。
5. **テストスイート**: `cargo test -p engine` `cargo test -p train` 全パス(既存テストは修正なしでパスするのが理想。やむを得ず修正する場合は理由を作業ログに)。
6. **FFO不変**: レガシー経路でFFOテスト(終盤ソルバー)が完全不変であること(終盤ソルバーは評価関数に依存しない経路もあるが、回帰確認として)。

## スコープ外

- 再学習の実行(T164)・対局ゲート(T165)・本番配線
- レガシースキームの削除(将来のクリーンアップタスク)
- パターン形状自体の変更(Edax寄せはキュー6番の別タスク)

## 受け入れ基準

1. `cargo test -p engine` `cargo test -p train` 全パス(新規性質テスト込み)
2. 新スキームの全8対称一致テストが存在し、**修正前のコードに同テストを適用すると失敗する**ことの実証(regression-catching、方式はT117前例=stashやworktreeでの逆適用確認)が作業ログにある
3. レガシー経路のビット不変の実証(既存重みでの評価値一致)が作業ログにある
4. NPS参考値の記録
5. 完了時 `git status --short` クリーン(変更ファイルはパス明示でコミット。`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- NPS計測は専有状態で(T162対局・他の重い処理と重ねない)。detached+ツール呼び出しポーリング、Monitor通知依存禁止。作業ログはタスクファイルへ節目ごと追記

## 作業ログ

- 2026-07-21 実装(implementer、Sonnetフォールバック)
  - **前提調査**: `engine/src/patterns.rs`(`compute_pattern_classes`、384-432行付近)、
    `engine/src/pattern_eval.rs`(`PatternWeights::score`/バイナリ入出力)、
    `train/src/regression.rs`(`sgd_step`)を読了。根本原因(タスク仕様記載どおり
    「先着順」の`aligned_cells`選択が全域D4変換と不整合)を実際に数式で追った上で
    実装方針を確定させた(下記「設計判断の根拠」参照)。

  - **設計判断の根拠(なぜ`aligned_cells`自体を直さず後段canonical化で済むか)**:
    盤面全体の対称変換`h`について`score(transform(board,h))`を展開すると、
    各インスタンス`i`の寄与は`state(h^{-1}∘aligned_cells[i], board)`になる
    (`transform_board`の定義から)。これは、同じクラスの別インスタンス`j`
    (`h^{-1}`でインスタンス`i`のセル集合に写る側)の`aligned_cells[j]`を、
    代表パターン`R`の**安定化群**(`R`のセル集合を保つD4変換の部分群)の要素`s`
    による位置置換だけ並べ替えたものに一致する(`h^{-1}g_i = g_j∘s`となる
    `s∈Stab(R)`が必ず存在するため)。したがって、状態インデックスを
    「安定化群の像の最小値(canonical index)」に正規化しておけば、
    どのインスタンスの`aligned_cells`選択が(安定化群の要素の分だけ)恣意的で
    あっても正規化後の値は不変になり、`aligned_cells`選択ロジック自体は
    一切変更せずに全8対称での完全一致を達成できる。この事実は
    `engine/src/patterns.rs`のT163節コメントに証明の要旨を記載した。

  - **実装(新旧共存)**:
    - `engine/src/patterns.rs`: `stabilizer_position_permutations`(パターンの
      安定化群が状態インデックスの桁に誘導する置換の一覧)・
      `build_canonical_index_table`(状態→canonical indexの表、構築時に一度だけ
      計算)を追加。手作業のクラス分類ではなく、既存の`apply_symmetry`から
      機械的に導出する(このリポジトリの既存方針を踏襲)。
    - `engine/src/pattern_eval.rs`: `PatternWeights`に`canonical_tables:
      Option<Vec<Vec<u32>>>`を追加(`None`=レガシー、`Some`=新スキーム)。
      `zeroed_canonical`(新スキームでの0初期化コンストラクタ)・
      `table_index`(スコア計算・SGD更新の両方が経由する、raw_state→実インデックス
      変換。レガシーでは恒等)を追加し、`score`はこれを経由するよう変更。
      新形式`"PWV5"`(`to_bytes_v5`/`from_bytes_v5`)を追加: バイト列レイアウトは
      既存の自己記述形式`PWV3`と全く同じ(マジック・バージョンのみ異なる)ため、
      シリアライズ/パース本体を共通ヘルパー(`to_bytes_self_describing`/
      `from_bytes_self_describing`)に切り出して両者で共有(ドリフト防止)。
      canonical indexテーブル自体はファイルに保存せず、読み込み時にパターン
      形状から再計算する(`class_info`を保存しない既存方針と同じ)。
      レガシー形式(PWV1〜PWV4)のパース・シリアライズは無変更
      (`canonical_tables: None`をコンストラクタに追加しただけ)。
    - **設計選択の記録(タスク仕様3の「実装が単純な方を選んでよい」の適用)**:
      テーブルサイズは「フルサイズのまま同値エントリを共有」を選択(canonical
      indexのみを格納する圧縮版ではない)。理由: 実装がシンプルで、既存の
      `PatternWeightTable`構造体・読み書きロジックを変更せずに済むため。
      非canonicalなインデックスに書き込まれる重みは(読み書き双方が
      `table_index`を通るため)常にゼロのまま残り無害。ファイルサイズの
      増加分はT164での再学習時に実害があれば別途最適化を検討する。
    - `train/src/regression.rs`: `sgd_step`の勾配読み書きを`weights.table_index`
      経由に変更(レガシーは無変更のまま、canonicalスキームでは勾配が
      canonicalエントリに集約される)。`Model::new_canonical`・
      `Model::to_bytes_v5`を追加。

  - **性質テスト(要件1、最重要)**:
    - `engine/src/pattern_eval.rs`に4本追加: (a) 決定的seedのランダム盤面300局面
      ×全8対称(`t163_canonical_score_is_invariant_under_all_eight_d4_symmetries_of_random_boards`)、
      (b) 自己対戦(合法手のみ、パス・終局間際を含む12局)の全局面×全8対称
      (`..._across_self_play_games_including_near_endgame`、200局面超を確認)、
      (c) V3パターン形状(edge2x/対角オフセット5-6-7/隅5x2、非正方形軌道)
      80局面×全8対称(`..._for_v3_pattern_shapes_including_non_square_orbits`)。
    - `train/src/regression.rs`に実WTHORデータでの検証を追加
      (`t163_canonical_score_is_invariant_over_real_wthor_positions`):
      `train/data/WTH_2000.wtb`(実際のフランスオセロ連盟提供棋譜、4253局)から
      先頭40局を再生し、5手ごとにサンプリングした実局面(100局面超)で
      同様に全8対称一致を確認。要件1(b)「WTHOR実局からサンプリングした
      実局面」を文字通り満たす。
    - SGD学習後もD4不変性が保たれることの確認
      (`canonical_model_predictions_stay_d4_invariant_after_training_on_asymmetric_samples`、
      30局面×20エポック学習後、全8対称で予測一致)。

  - **regression-catching実証(受け入れ基準2)**: `PatternWeights::table_index`を
    一時的に`raw_state as usize`を無条件に返すだけの実装(canonicalテーブルを
    無視する=修正前のレガシー相当の挙動)に書き換え、
    `cargo test -p engine t163_canonical -- --nocapture`を実行したところ、
    3本の性質テストすべてが**最初の局面・最初の対称変換で即座に失敗**した
    (例: `random board #0: sym=1 mover=Black: ... got 541.5516 vs base 541.653`、
    `game #0: sym=4 mover=Black: ... got 544.3107 vs base 544.2927`、
    `v3 random board #0: sym=1 mover=Black: ... got 1754.6241 vs base 1754.2158`)。
    修正(`table_index`を`canonical_tables`経由に戻す)を適用して再実行し、
    8件全て合格に戻ることを確認した。これにより、新規テストが実際に本タスクの
    対象バグを検出できることを実証した(T117前例の「一時的にロジックを戻して
    テストが落ちることを確認する」方式)。

  - **レガシー経路のビット不変の実証(受け入れ基準3)**: 既存テスト
    `production_pwv3_scores_match_parent_commit_golden_bits`(本番用
    `train/weights/pattern_v4.bin`をロードし、実対局由来8局面のスコアを
    ハードコードされたgolden bit列と比較)と`zero_scalar_coefficients_are_bit_exact_with_pwv3_scores`
    (同ファイルで40手の自己対戦全手についてビット完全一致を検証)を無変更で
    再実行し、両方とも合格(golden値は本タスクよりずっと前のコミットで採取
    されたもの)。これにより、レガシー経路(PWV1〜PWV4)の評価値が本タスクの
    変更の前後でビット単位で不変であることを直接確認した(`cargo test -p engine
    pattern_eval::tests::production_pwv3_scores_match_parent_commit_golden_bits
    pattern_eval::tests::zero_scalar_coefficients_are_bit_exact_with_pwv3_scores`)。

  - **NPS参考値(要件3)**: 新規`engine/tests/t163_canonical_nps_bench.rs`
    (T158a層化8局面ベンチ`bench/edax-compare/t158a_engine_cost_positions.json`
    を流用したマイクロベンチ、`score()`呼び出し単体のスループット比較、
    ゼロでない同一分布の重みを両スキームに設定)。他の重い処理(ビルド・
    通常のtest実行)と重ならない専有タイミングで単独実行:
    `cargo test -p engine --test t163_canonical_nps_bench --release -- --nocapture`
    → `legacy_nps=4,622,874 canonical_nps=4,506,141 ratio(canonical/legacy)=0.9747`
    (canonical化スキームは表引き1回追加分で約2.5%のコスト増、目安「95%以上」
    を満たす)。ゲート判定はT165の実対局で行う(本タスクは参考記録)。

  - **FFO不変(要件6)**: `cargo test -p engine --test ffo_bench --release --
    --nocapture ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps`
    を実行し、#40-#44全問正解を確認(終盤ソルバーは`PatternWeights::score`に
    依存しない経路のため無影響、想定どおり)。

  - **全体テスト**: `cargo test -p engine`(224 passed, 2 ignored=release専用)・
    `cargo test -p train`(101 passed)・`cargo build --workspace`いずれも合格。

  - **仕様どおりにできなかった点・判断に迷った点**:
    - PWV5はscalar feature(PWV4のExactMobilityAdvantage等)を持たない
      (PWV3相当のパターンのみの形式)。理由: T163のスコープはD4
      canonical化そのものであり、scalar featureは既にD4不変であることが
      既存テスト(`scalar_features_match_reference_and_obey_color_and_d4_symmetry`)
      で確認済みで本タスクの対象外。T164(再学習)でscalar featureとの併用が
      必要になった場合、PWV5にscalar feature拡張を追加する(PWV4と同様の
      レイヤー化)か、新フォーマット番号を割り当てるかはT164側の判断とする。
    - canonical indexテーブルの格納方式は「フルサイズ+ゼロ埋め共有」を選択
      (上記参照)。ファイルサイズ削減が必要になればT164以降で再検討。

  - **変更ファイル**: `engine/src/patterns.rs`・`engine/src/pattern_eval.rs`・
    `train/src/regression.rs`(既存3ファイルの変更)、`engine/tests/t163_canonical_nps_bench.rs`
    (新規)。`git status --short`はこの4件のみ(`tasks/`・`CLAUDE.md`は含まれず)。
