# T163 D4 canonical化 — 最終レビュー(Claude代替、Codex usage limit中)

- 対象: コミット `ccb93eb`(engine/src/patterns.rs, engine/src/pattern_eval.rs, train/src/regression.rs, engine/tests/t163_canonical_nps_bench.rs)
- 親コミット: `bc7ea6f`
- レビュー方法: 差分精読 + 既存コード(compute_pattern_classes / apply_symmetry / pattern_state_index / score / schema_hash / to_bytes_v4)との突き合わせ + 数学的証明の独立検証 + テスト数のgit grep実測。コード実行はせず静的検証(implementer報告のテスト実行結果は作業ログのものを前提)。

## 総合判定: **合格**(重大指摘なし。中2件はT164前に対処推奨だが本タスクのdone判定は妨げない)

---

## 1. 数学的正当性(最重要) — 検証済み・正しい

T163証明スケッチ(patterns.rs T163節コメント・作業ログ)を独立に再構成して検証した。結論: **主張は正しい**。

検証の要点(実装の定義と突き合わせた完全な導出):

1. `transform_board(board,h)` は `transformed[c] = board[h^{-1}(c)]` を満たすので、
   `state(aligned_cells[i], transform(board,h)) = state(h^{-1}∘aligned_cells[i], board)`。
2. `aligned_cells[i] = g_i∘rep`(rep自然順、`g_i = symmetry_of[i]`)。`k := h^{-1}∘g_i` はD4元で、
   `k(repのセル集合)` は必ずパターンリスト内のどれかのインスタンス`j`のセル集合に一致する。
   ここで暗黙の前提「**パターンリストがD4で閉じている**」が必要だが、現行の全構成で成立を確認:
   v2の22個(行⇔列、対角2本、隅3x3の4個)は閉、edge2x/対角オフセット/隅5x2は
   `symmetry_orbit`(全8変換の重複除去)で生成されるため構成的に閉。`j`は同クラスに割り当てられる
   (`compute_pattern_classes`は任意のsymでの集合一致で割当てるため)。
3. `s := g_j^{-1}∘k` は rep のセル集合を保つので `s ∈ Stab(R)`、すなわち `h^{-1}∘g_i = g_j∘s`(主張どおり)。
4. **(a) 桁置換への誘導の正しさ**: `stabilizer_position_permutations` は
   `cells[sigma[p]] = apply_symmetry(sym, cells[p])` となる σ を、セル集合を保つ全symについて列挙する。
   これは s↦σ_s の写像であり、cells[σ_{s2∘s1}(p)] = cells[σ_{s2}(σ_{s1}(p))] から**準同型**、
   列挙範囲がStab(R)全体なので像は**群**(逆元を含む)。導出すると
   `state(k∘rep, board)` の桁pは `state(aligned_cells[j], board)` の桁σ_s(p)であり、
   `permute_state_digits(u, σ)` の定義(桁pを桁σ[p]へ移す→結果の桁pは元の桁σ^{-1}(p))から
   `state(k∘rep, board) = permute_state_digits(state(aligned_cells[j], board), σ_{s^{-1}})`。
   σ_{s^{-1}} = σ_s^{-1} はStab(R)全列挙により必ずpermsに含まれる。したがって両stateは
   同一の置換群軌道に属し、**軌道min(canonical index)は一致する**。ここが証明の核心で、実装と完全整合。
5. i↦j(`cells_j集合 = h^{-1}(cells_i集合)`)はクラス内の全単射(セル集合は相異なる)、
   stage(空きマス数)はD4不変、moverは不変。よって寄与項の多重集合が一致し、score合計が一致する。∎

- **(b) 3進桁順序との整合**: `permute_state_digits` の桁重み(位置pに3^p)は `pattern_state_index` と同一の規約(POW3)。軌道の代表としてu32のminを取るのは任意の決定的な代表選択として妥当で、桁順序の規約に依存した正しさの問題はない。
- **(c) 軌道サイズ8・安定化群自明の場合(隅5x2)**: 質問の理解は**正しい**。|Stab(R)|=1なら剰余類分解が自明で、rep集合→各インスタンス集合を写すD4元は一意。よって`compute_pattern_classes`の「先着順break」に恣意性の余地自体がなく、`h^{-1}∘g_i = g_j`が厳密に成立して正規化(恒等)なしで不変。上記4の導出はs=eの特殊例として包含される。**ただしこのケースが性質テストで実際にカバーされていない点は指摘2を参照。**
- 補足: 同じクラス内で複数インスタンスが同一canonicalエントリを共有していても(例: 行クラス8本が同じテーブルを引く)、上記は各インスタンス独立に成り立つので問題ない。180度回転と転置が対角線上で同じσを誘導する等、permsに**重複σが入りうる**が、minには無害(軽微指摘4)。

## 2. canonical_tables構築の正しさ — 問題なし

- `build_canonical_index_table`: 全状態 `0..3^len` について perms 全体のminを取る素直な実装。σ集合が群である(上記)ため軌道はstate空間を分割し、**べき等性** canonical(canonical(x))=canonical(x) が構造的に成立(`canonical_index_table_is_deterministic_never_exceeds_raw_and_is_a_fixed_point` テストが fixed-point・単調性・決定性を直接検証しており適切)。
- **決定性**: sym走査順0..7固定、u32のmin、HashSetは集合等値比較のみに使用(反復順序非依存)。プラットフォーム非依存で決定的。ロード時再計算(ファイル非保存)も、ファイル内のパターン定義+`compute_pattern_classes`再計算+代表の自然順セルのみから導出されるため決定的。保存時と読込時で同じ`patterns[rep_idx]`(代表のaligned=自然順)を使う整合も確認した。
- `unwrap_or(state)` はpermsが常に恒等を含む(sym=0)ため実際には到達しないが無害。

## 3. レガシー経路の完全不変 — 根拠十分

- `score` の変更は `state as usize` → `table_index(class_id, state)` のみで、`canonical_tables: None` では `raw_state as usize` をそのまま返す恒等関数。演算列は同一(関数呼び出し1段のみ追加)で浮動小数点結果はビット同一。`sgd_step` も同様。
- PWV1/PWV2/PWV4のパース・シリアライズは `canonical_tables: None` のフィールド初期化追加のみ。
- PWV3パーサの `from_bytes_self_describing` への共通化は、差分精読の結果**エラーメッセージの文字列パラメタ化以外にロジック変更なし**(version検査・stage検査・上限・schema hash・class照合・余剰bytes検査すべて同一)。
- 実証としてgolden bitテスト2本(`production_pwv3_scores_match_parent_commit_golden_bits` / `zero_scalar_coefficients_are_bit_exact_with_pwv3_scores`)が無変更で合格しており、golden値は本タスク以前のコミット採取のため独立性がある。妥当。

## 4. PWV5形式 — 概ね良好、片方向のガード欠落あり(指摘1)

- 共通ヘルパー化(`to_bytes_self_describing`/`from_bytes_self_describing`)はドリフト防止として適切。マジック・バージョンのみ引数化。
- 相互拒否: 旧コード×PWV5ファイル → 旧`from_bytes`にPWV5アームがなく明示エラー(構造的に保証)。新コード×PWV3 → magicディスパッチで`canonical_tables=None`のまま(`t163_pwv3_bytes_are_read_as_legacy_even_through_the_shared_parser`で検証)。`to_bytes_v5`は非canonicalモデルでassert(テストあり)。schema-hash破壊の拒否テストあり。
- canonical tables非保存・再計算方針の決定性は上記2のとおり問題なし。
- ただし**逆方向のガードが無い**(指摘1)。

## 5. テスト品質 — 良好、報告数値の疑義は解消(テスト削除なし)

- 性質テストは公開API `PatternWeights::score`(=探索・学習が使う実経路)を通る。判別用重み(class/stage/state毎に異なる値)で「たまたま一致」を回避する設計も適切。カバレッジ: ランダム300局面(非合法含む=検証範囲拡大として合理的)、自己対戦12局(パス・終局間際含む、200局面超)、V3形状80局面、実WTHOR40局100局面超、SGD学習後の不変性。regression-catching実証(table_indexを恒等化して3テストが即失敗)は作業ログに具体値付きで記録されており、T117方式を満たす。
- **train側137→101の実態: テスト削除はない**。git grepで確認: `#[test]`数は regression.rs 14→19(+5)、train側の他ファイルすべて増減なし。内訳: libターゲットのテスト数は 96→101 で、「101 passed」は**libターゲット単体**の集計。前回報告の「137」は lib(96)+bin群(40)+統合テスト(1)=137 の**全ターゲット合計**と一致する。つまり今回142(全ターゲット)に増えており、報告の数字は集計範囲の不一致による見かけ上の減少(報告品質の問題、コードの問題ではない。軽微指摘5)。
- engine側も 224 passed 報告と整合(pattern_eval 29→37、patterns 23→29、NPSベンチ+1)。
- golden bitテストの独立性: golden値は変更前から存在するハードコード値で、本コミットで無変更。独立性あり。

## 指摘事項

### 重大(ブロッカー): なし

### 中

1. **シリアライズ側の混在ガードが片方向のみ**: `to_bytes_v5`は非canonicalを拒否するが、**`to_bytes`(PWV2)/`to_bytes_v3`はcanonicalモデルを黙って受け付ける**。canonical学習済みモデルを誤って`to_bytes_v3`で保存するとPWV3ファイルが生成され、読み込み側はレガシーとして解釈(非canonical状態のエントリはゼロのまま)→**明示エラーなしに壊れた評価値**になる。要件4「静かに混在しない(明示エラー)」の読み込み方向は満たすが書き出し方向が未然防止されていない。T164はtrainerバイナリからの保存経路を書くタスクなので踏みやすい。対処: `to_bytes`/`to_bytes_v3`に`assert!(!self.is_canonical())`を追加(T164冒頭での対応で可。`to_bytes_v4`はscalar非空assertで偶然弾かれるが明示化が望ましい)。同様に、canonicalモデルにbuilder(`with_zeroed_scalar_features`等)でscalar特徴を付けた場合、`to_bytes_v5`(PWV3レイアウト=scalarブロックなし)が**scalar重みを黙って落とす**。現状この組み合わせを作る経路はテスト・binに存在しないが、`to_bytes_v5`に`assert!(self.scalar_feature_weights.is_empty())`を足しておくのが安全。
2. **作業ログ・テストコメントの「隅5x2」カバレッジ主張は誤り**: 作業ログの性質テスト(c)とテストコメントは「V3パターン形状(edge2x/対角オフセット5-6-7/**隅5x2**)」と記載するが、`generate_patterns_for(PatternConfig::V3)`は**corner5x2を含まない**(含むのは`V2Corner5x2`のみ。patterns.rs 219-231行)。よって軌道サイズ8・安定化群自明のケースは性質テスト・patterns.rsのテーブルテストのいずれからも漏れている。上記1(c)のとおり理論上は正規化が恒等になり不変性は自明に成立し、V2Corner5x2はablation用構成で本番非使用のため実害は低いが、**受け入れ根拠の記述が事実と異なる**点は修正が必要(作業ログの訂正+可能ならテストの対象configに`V2Corner5x2`を1本追加)。

### 軽微

3. **「完全一致」は浮動小数点丸めを除いての一致**: 対称変換後はインスタンス和の加算順序が置換されるため、f32の非結合性により最終値は最大数ulp(スコア~2000で~1e-3程度)ズレうる。テストの許容誤差1e-2はこれを正しく吸収しており妥当。ただし判別用重みの粒度が1e-4のため、理論上「1インスタンスだけ僅かに近い状態へ誤canonical化」する類のバグは1e-2未満に埋もれうる(実際のバグ発現は0.1〜0.4のズレで検出済みなので実用上は問題なし)。ドキュメント上の「ビット単位の完全一致」ではなく「数値的一致」である点だけ認識しておくこと。
4. `stabilizer_position_permutations`は**重複した置換を返しうる**(例: 主対角線ではsym=0とsym=6が同じ恒等σ、sym=2とsym=7が同じ反転σを誘導し、4要素中2種)。minには無害だが、docコメントに「セル集合の安定化群の要素数分(誘導置換として重複しうる)」と一言あるとテスト名`main_diagonal_stabilizer_has_four_elements`(セル集合安定化群=4、誘導置換群=位数2)との関係が明確になる。
5. 完了報告のテスト数「101」はlibターゲット単体の数字で、前回の「137」(全ターゲット合計)と集計範囲が異なり誤解を招いた(実際は96→101、全体137→142で純増)。今後の報告は集計範囲を明記のこと。
6. schema-hashはmagic/versionを含まないため、PWV3⇔PWV5でハッシュ値は同一(スキーム判別はmagic/versionのみが担う)。ファイルのmagic+versionを同時改竄すればスキームを静かに入れ替えられるが、これは既存形式群と同水準の設計であり実運用上の問題ではない。

## 6. T164(再学習)への申し送り

- **保存はModel::new_canonical + Model::to_bytes_v5のみを使う**こと。`to_bytes`/`to_bytes_v3`/`to_bytes_v4`をcanonicalモデルに使うと指摘1のとおり静かにスキームが失われる(T164着手前にassert追加推奨)。
- **61段v4ステージ構成との併用は可能**: `is_supported_stage_definition`が(13,5)と(61,1)の両方を許容し、PWV5は共通パーサ経由で両方読めるため、`zeroed_canonical(patterns, V4_NUM_STAGES, V4_STAGE_EMPTY_DIVISOR)`でcanonical×61段の学習・保存ができる。
- **B3構成(scalar特徴入り)のcanonical学習は現状不可**: PWV5はPWV3レイアウト(scalarブロックなし)であり、`new_with_scalar_features`にcanonical版もない。B3相当をcanonicalで学習するにはPWV5のscalar拡張(PWV4方式のレイヤー化)または新フォーマット番号が必要。パターン部分のみのcanonical学習(v4相当の再現)は問題なくできる。実装者の作業ログもこの制約を明記しており判断は妥当。
- **未使用エントリ**: 非canonical状態のエントリは読み書きとも`table_index`を通るため常にゼロのまま無害。ファイルサイズはフルサイズ(8セル・安定化群位数2のクラスで実効自由度は約半分の3321/6561)だが、L2正則化もcanonicalエントリにのみ掛かるため学習品質への影響はない。サイズ削減は実害が出てから(作業ログどおり)でよい。
- 学習サンプルへのD4データ拡張(8対称に増やす)は、canonicalスキームでは同一エントリへの勾配集約になるだけなので必須ではないが、やる場合も正しく動く(sgd_stepは逐次更新)。
