# T088 最終レビュー: 学習法改善の8構成ablation(a788357..9c0738f)

> **注記**: 本来この最終レビューは Codex(gpt-5.6-sol)が担当するが、Codex利用上限のため Claude(Fable 5 サブエージェント)が代替として実施した。

- 対象コミット: 9c0738f(範囲 a788357..9c0738f、単一コミット)
- 対象ファイル: `train/src/t088_experiment.rs`(新規610行)、`train/src/experiment.rs`(新規318行)、`train/src/train_data.rs`、`train/src/regression.rs`、`train/src/bin/train_patterns.rs`、`train/src/bin/train_patterns_v3.rs`、`engine/src/pattern_eval.rs`、`bench/edax-compare/compare_pattern_v3.py`、`bench/edax-compare/smoke_pattern_v3.py`、`train/src/lib.rs`
- 参照仕様: `tasks/T088-training-improvements.md`(明確化4点込み)、`tasks/design/T085-beat-level10-report.md` §6.1〜§6.7

## 総合判定: **合格**

ブロッカーなし。設計書§6の各アルゴリズム(年代分割・D4正規化・後年優先重複除外・Huber勾配・early stopping・stage逆平方根sampling・X/C vulnerable判定)は実装と一致し、前提修正5件も実装・検証済み。採用ゲート(a)〜(e)の数値・判定は作業ログと整合し(独立再計算で確認)、最終判定「不採用」は正当。スコープ逸脱なし。中程度の指摘3件はいずれも「不採用」という最終結論を変えない解釈上の注意であり、redo不要。STATUS.mdへの申し送りを推奨する。

---

## 1. 正しさ(設計書§6との照合)

### 1.1 年代分割(§6.1)— 一致
`t088_experiment.rs` `canonical_year_split` / `raw_year_split`: year≤2022→train、2023→validation、それ以外→test。年はWTHORファイルヘッダ由来で対局単位に付与されるため、分割は対局単位で固定 ✓。構成1の `baseline_split` は明確化3どおり「2015〜2023・対局単位ランダム90/10」で、2024はどの構成でも学習・チューニングに不使用 ✓(seed別に決定的なxorshiftシャッフル)。

### 1.2 D4 canonical key(§6.2)— 一致
`experiment.rs` `canonicalize`: 8対称(D4群、`engine::patterns::apply_symmetry`。群性はengine側テストで担保)で盤面を変換し、`(black_bits, white_bits, mover)` の辞書順最小をkeyとする ✓。moverは対称変換で不変なのでkeyに含めるだけで正しい。`aggregate` はcanonical keyごとに outcome平均(f32 target)・分散・出現回数・年(最大)・直前着手種別(X/C/other別カウント)・vulnerable回数を保持 ✓。パターン評価は対称instanceがclass tableを共有するためD4不変であり、canonical盤面で学習しても元盤面と等価 — canonical化の前提は成立している。

### 1.3 後年優先の重複除外(§6.2)— 一致
`remove_cross_split_leaks`: testに存在するkeyをtrain/validationから除去し、次にvalidationに存在するkeyをtrainから除去(test > validation > train)✓。除外件数3種を返しmanifestに記録 ✓(作業ログの 4,236 / 8,502 / 4,494 と項目対応)。単体テスト `later_split_wins_without_leakage` あり。

### 1.4 Huber勾配(§6.3)— 一致
`regression.rs` `Loss::Huber { delta }` で勾配を `error.clamp(-delta, delta)` ✓。L2項はclamp外で加算(正しい)。δはCLI `--huber-delta` で候補{4,8,12}を切替可能、選択はseed 1のvalidationのみ(明確化2)で実施され、作業ログに3候補の値が記録されている ✓。外れ値勾配のclampを検証する単体テストあり。

### 1.5 early stopping / LR decay(§6.4)— 一致
`run_one`: 最大60epoch(early時)/20epoch(非early)、初期lr 0.005、`since_decay>=2` でlr半減(下限0.0003125)、`stale>=5` で停止、min_delta 0.02 ✓。**絶対最良(`validation_mae < best_mae`、min_deltaなし)でbest.binを保存**し、**patience基準(`validation_mae + 0.02 <= patience_mae`)は停滞カウント専用**に分離 — タスク作業ログの記載どおり ✓。最終モデルはbest.binから復元 ✓。各epoch終了時にstate(epoch/lr/best_mae/patience_mae/best_epoch/stale/since_decay/shuffle_seed/manifest_hash)→weightsの順で原子的に保存し、weightsを完了マーカーとして不完全世代を無視する設計(`latest_checkpoint` は .bin と .state の揃った最大epochを選ぶ)。クラッシュ位置ごとに検討したが、resumeは決定的(shuffle seed = seed^epoch、f32直列化は可逆)で健全 ✓。

### 1.6 stage逆平方根sampling(§6.5)— 一致
`sampling_order`: `weight = sqrt(max_count/count).min(4.0)` ✓。元サンプル数と同数の重み付き復元抽出(設計の「weighted shuffleで同数抽出」の合理的解釈。非復元同数抽出では意味をなさないため復元抽出で正しい)。決定性とcap遵守の単体テストあり。

### 1.7 X/C vulnerable判定(§6.6・明確化4)— 一致
`train_data.rs` `last_move_metadata`: X={9,14,49,54}(b2/g2/b7/g7)、C={1,6,8,15,48,55,57,62}(b1/g1/a2/h2/a7/h7/b8/g8)を対応する隅(0/7/56/63)にマッピング — 全12セル・対応隅を設計書座標と照合し正しい ✓。隅の空き判定は**着手前の盤面** ✓。サンプルは「X/C着手後の局面・次手側視点outcome」 ✓。固定罰則・target変更なし(提示頻度のみ)✓。X/C high-loss率は frozen 2024 canonical の vulnerable subset で `|予測 − canonical平均outcome| >= 8` の割合(`xc_metrics`)— 明確化4の定義どおり ✓。subset MAEも記録 ✓。

### 1.8 8構成の定義(§6.7・明確化1)— 一致
`Method::from_number`: canonical=3+、huber=4+、early=5+、stage={6,8}、xc={7,8} — 明確化1(案A: 6=stage単独、7=X/C単独、8=両方)どおり ✓。なお候補選択でX/C=「なし」(倍率1)が選ばれたため、実行上は構成7≡5・8≡6となり、結果表の完全一致(コード上も倍率1では素shuffle経路に合流)はこれで説明でき、決定性の傍証にもなっている。

## 2. 評価プロトコルの一貫性

- **frozen 2024 test は全構成共通**: `run_one` は構成1〜8すべてで同一の `common_test`(canonical平均target・リーク除去後も不変のtest集合)に対してMAE/MSE/X/C指標を計算する。**ゲート(b)(d)の構成間比較は同一評価セット・同一target定義で公平** ✓。
- **validation は構成ごとに定義が異なる**(構成1=ランダム10%生サンプル、構成2=2023生、構成3+=2023 canonical平均)。これはablationの構造上不可避だが、ゲート(a)の解釈に注意が必要(下記「中2」)。

## 3. 前提修正5件(T087申し送り)

1. **compare/smoke のチェックポイント+resume+identity照合** — 実装済み ✓。両スクリプトとも1局面/1対局ごとに `atomic_json`(tmp→`os.replace`)で逐次保存、metadata(schema/depth/重みSHA-256/eval_cli/Edax/eval.dat/corpus/gitTree)不一致でresume拒否、`--stop-after` で中断テスト可能。作業ログに中断→resume・identity拒否の検証記録あり ✓。
2. **学習CLIのrun identity照合** — 実装済み ✓。T088: run dirの `identity.txt`(schema=2/data_hash/manifest_hash/config/seed/max_epochs/huber_delta/l2/stage/xc/validation_only)不一致で拒否。T087 v3 trainer: checkpoint/finalごとに `.meta` を先行保存し `verify_identity` で照合。作業ログにL2変更・epochs変更の拒否検証あり ✓。
3. **results.tsv のrun完了ごと原子的追記** — 実装済み ✓。`append_result` がrun単位で読み込み→追記→原子的置換(重複キーはスキップ)。v3 trainer側の一括書き出しも撤廃。
4. **PWV3上限チェック+否定テスト** — 実装済み ✓。`MAX_PWV3_INSTANCES=256`/`MAX_PWV3_CLASSES=64` を確保前に検査し、残りbyte数の下限(instance 4byte+class 161byte=1+4+13ステージ×3状態×4byte、数学的に正しい下限)との整合を `checked_mul/checked_add` で検証。否定テスト2件追加 ✓。既存の正当なPWV3を誤拒否しない(下限のみの検査)。
5. **provenance記録** — 実装済み ✓。compare出力のmetadataに重み/eval_cli/Edax/eval.dat/corpus SHA-256とgit treeを保存。作業ログのゲート(c)に実値が記載されている ✓。
6. (軽微・ついで) `atomic_write` はWindowsで `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)` による安全置換に、Edax一時ファイルは `NamedTemporaryFile` で一意化 ✓。

## 4. 採用ゲート判定の整合(独立再計算)

| ゲート | 作業ログの値 | 再計算 | 判定整合 |
|---|---|---|---|
| (a) validation MAE改善(3seed) | 12.707% / 11.222% / 11.978% | (16.272653−14.204909)/16.272653=12.707% 他2seedも一致 | ✓ 合格判定は計算どおり(ただし中2の注意) |
| (b) frozen 2024中央値MAE 5%改善 | 14.577849→14.269088、2.118% | 0.308761/14.577849=2.118% < 5% | ✓ 不合格 |
| (c) oracle regret 10%改善 | 1.888889→2.444444、29.412%悪化 | (2.444−1.889)/1.889=29.41%悪化 | ✓ 不合格 |
| (d) X/C high-loss率 20%改善 | 0.544949→0.541324、0.665% | 0.003625/0.544949=0.665% < 20% | ✓ 不合格 |
| (e) NPS 95%以上 | 409,179→425,934、104.09% | 425934/409179=104.1% | ✓ 合格 |

(b)(c)(d)不通過による**不採用判定は妥当**。「失敗実験も設定・指標を残す。不採用も正常完了」の規範どおり、全構成の指標・manifest・provenanceが残されている。既存pattern_v2.bin(2015-2024リークあり)は参考値1行のみ・採用判断不使用(明確化3どおり)✓。

## 5. スコープ遵守

- engine既定評価・アプリ/WASMへの配線: **なし** ✓(engine側の変更はPWV3ローダの検証強化+テストのみ。search/評価経路・app/ は無変更)。
- `train/weights/pattern_v2.bin`: コミットに含まれず不変 ✓。
- 新重みファイル: 未コミット ✓(不採用のため正しい)。
- 中間生成物: `--checkpoint-dir` はgitignore領域(train/data/配下)指定 ✓。コミットは対象10ファイルのみ。

---

## 指摘事項

### 重大(ブロッカー)
なし。

### 中

1. **全構成にbest-validation-epoch復元が適用され、構成1が厳密な「現行再現」でない**(`t088_experiment.rs` `run_one`: best.bin保存と最終モデル読み込みが `method.early` に依存しない)。現行法(train_patterns)は最終epoch重みを使うため、構成1〜4は本来より強いbaselineになっている。影響: (i) ゲート方向は保守的(baselineが有利)で「不採用」判定は揺らがない、(ii) ただし構成4→5の増分が「patience停止+LR decay+60epoch」のみに縮み、ablationの解釈がやや濁る。申し送りで足りる。
2. **ゲート(a)のvalidation MAE比較は構成間でtarget定義が異なる**。構成1(生サンプル・ランダム10%)と構成5(canonical平均・2023)の比較では、平均化により不可避ノイズが減る分MAEが機械的に下がる(構成2→3の16.0→14.4の急落が主にこれ)。「12%改善」をモデル品質の改善と読むのは過大評価であり、公平な比較は全構成共通のfrozen 2024(2.118%改善、ゲート(b)で正しく不合格)。明確化3の字義(構成1をbaselineとする)には沿っており判定変更は不要だが、後続タスク(T090等)で(a)を根拠に引用しないこと。
3. **構成1〜2の学習データはcanonical重複除去を受けておらず、2024 testとkeyが重複する生サンプルを含みうる**(構成3+はtrainから2024 keyを除去済み)。baseline側だけがtest近接データで学習する非対称で、ゲート(b)をわずかに厳しくする方向(保守的)。「現行再現」の定義上不可避だが、frozen比較の解釈時に留意。

### 軽微

1. `experiment.rs` `sampling_order`: 全サンプルがvulnerableかつcap<1.0の場合、cap到達後に空のregular配列へ `cumulative[position.min(len-1)]` でアクセスし減算オーバーフローでpanicする理論的経路(実データではvulnerable約2.9%で到達不能)。
2. `t088_experiment.rs`: `identity.txt` が(手動削除等で)存在しない場合、checkpointが残っていても照合なしでresumeされる。また `parse_state` は欠損キーでErrでなくpanicする(`state["epoch"]` 直接インデックス)。
3. `train_patterns_v3.rs` `append_result`: 重複判定キーが末尾タブなしの `"config\tseed"` のため、seed 1 と seed 1x が前方一致で誤スキップされうる(現用seedは1〜3で実害なし。t088側は末尾タブ付きで問題なし)。
4. `canonical_year_split`: manifestの `retained_years`・`train_mean_outcome_variance` がリーク除去**前**に計算されており、ラベルと実態が微妙にずれる(件数系は除去後で正しい)。
5. `data_files()` は `train/data/*.wtb` を年範囲でフィルタしないため、2015〜2024以外のファイルが置かれると無警告で分割に混入する(例: 2025年ファイルは「frozen 2024」testに入る)。manifestの年レンジ出力で観測は可能。
6. compare/smoke のresume identityに gitTree が含まれるため、無関係なコミット(tasks/のみ等)でも実行途中のチェックポイントが無効化される。安全側だが再実行コストに注意。
7. `--max-games` の意味がT088(ファイルごとの上限)とv3 trainer(全体上限)で異なる。smoke用途のみで実害なし。
8. canonical recordの `vulnerable_xc` は「1回でもvulnerable出現があればtrue」のOR集約で、subsetをわずかに広めに取る。全構成共通の定義なので比較の公平性は保たれる。

---

## 結論

総合判定 **合格**(done可)。実装は設計書§6・明確化4点・前提修正5件に忠実で、24 runの完走・ゲート判定・「不採用」の結論はいずれも妥当。中指摘3件(構成1のbest-epoch復元、ゲート(a)のtarget定義差、baselineの重複未除去)はすべて判定を保守的方向に振るもので再実行は不要だが、**T090(Edax教師蒸留)以降でT088の数値を引用する際はfrozen 2024の2.118%を基準にし、validation 12%改善を根拠にしない**ことをSTATUS.mdに申し送ることを推奨する。
