# T159 最終レビュー: 本番トレーナーへの早期打ち切り導入(Claude代替レビュー)

- 対象: コミット `8372aa2`(`train/src/bin/train_patterns_v3.rs`、935行追加・0行削除)
- レビュアー: Claude Fable 5(Codex usage limit中の代替。通常この領域はCodex担当のため観点を厚めに実施)
- 方式: `git show 8372aa2` の numstat/差分確認 + HEADのファイル全文精読(HEADとコミット内容が同一であることを `git diff 8372aa2 HEAD` = 空 で確認)+ `train/src/regression.rs` の関連API確認。コードは無修正。テスト実行は並列のverifierに委ね、本レポートは静的レビューに限定。

## 総合判定: **合格**(重大 0 / 中 3 / 軽微 7)

重大(ブロッカー)指摘なし。OFF経路の完全不変はコードレベルで確認でき、早期打ち切りロジック・resume・テストはいずれも要件を満たす。中指摘3件はいずれもT159の受け入れ基準を毀損しない「T160/T159bに向けた申し送り」または「稀な運用時の頑健性」であり、redo不要。STATUS.mdへの申し送りとT159b設計への織り込みを推奨する。

---

## 観点1: OFF経路の完全不変 — 確認OK

- **差分は純粋な挿入のみ**(numstat: 935 insertions / 0 deletions)。既存関数(`run_config_seed`・`append_result`・identity生成・`main`末尾のWTHOR既定ループ・simple-corpus経路)は1行も変更されていない。
- `main` への挿入は (a) 新フラグ4つのパース(L1155-1158)、(b) `--simple-corpus`併用ガードへの1ブロック追加(L1180-1183)、(c) ON時のみの値域チェック(L1189-1202)、(d) `games`読み込み直後の `if early_stop { return run_early_stop_wthor(...) }` 分岐(L1289-1303)のみ。いずれもOFF時は評価されるだけで副作用がない(`flag_present` は `env::args` の走査のみ)。
- 成果物の物理分離も確認: run_dir `-earlystop` サフィックス、最終bin `{name}-seed-{seed}-earlystop.bin`、`results-earlystop.tsv`(既存 `results.tsv` と別ファイル・別スキーマ)、`*-earlystop.metrics.json` / `*-earlystop.metrics.tsv`。identityは `schema=5-earlystop`(L1096)で既存 `schema=2` / `2-simple` / `3-t158` と衝突しない。同一 output_dir にOFF/ONを混在させても上書き衝突は起きない(例外1件は軽微7参照)。
- 共有関数(`atomic_write` / `save_artifact` / `verify_identity` / `latest_checkpoint` / `select_train_subset` 等)は無変更のまま再利用されており、暗黙の副作用なし。
- 作業ログのstash前後SHA-256一致(`5228350a...`)は方式・値とも妥当。テスト `off_path_matches_direct_model_training_bit_for_bit` は `run_config_seed` の出力を `Model::train` 直接呼び出しと比較しており、`Model::train` が `train_epochs(0, epochs)` への委譲(regression.rs L176-178)である以上「checkpoint分割ループ = 一括学習」という実質的な等価性検証になっている(自己参照ではない)。

**唯一の挙動差(軽微)**: 新フラグの値は `--early-stop` OFFでも eager に `.parse().unwrap()` される(L1156-1158)ため、`--early-stop-val-percent abc` のような不正値を渡すとOFF時でもpanicする。従来は「未知フラグは無視」だった invocation のみに影響し、正当な既存コマンドラインには一切影響しない。既存引数(`--epochs`等)も同じ `.unwrap()` 流儀であり、許容範囲。

## 観点2: 早期打ち切りロジックの正しさ — 確認OK

- **min-delta=0・タイ先勝ち**: `apply_early_stop_step`(L758-770)の厳密不等号 `val_mae < best_val_mae` がタイで先のエポックを保持し、タイでも `stale+1` が積まれる。テスト(8.0→5.0→6.0→6.0→7.0)でタイの扱いまで明示検証されている。
- **best.bin保存とfinalize復元**: 改善時のみ `best.bin` を保存(L933-940)、ループ終了後は `best.bin` を読んで最終成果物にコピー(L972-974)。「最後のエポックの重みではなくベストエポックの重み」が成果物になることは、テストが独立に再学習した1エポック目重みとのバイト一致で証明しており、180kスモーク(best_epoch=4、epochs_run=7、best.binとのSHA一致)とも整合。
- **max-epochs境界**: ループ条件 `epoch < max_epochs && stale < patience`(L915)。patience未発動でmaxに到達した場合もループを抜けて `best.bin`(=それまでのベスト)を最終成果物にする経路は共通であり、正しくベストが選ばれる。resumeテストがまさにこの経路(patience=10, max=4)を通している。
- **val split決定性**: `early_stop_game_hash`(L203-225)は盤面(black/white 64bit LE)・手番・outcome(f32ビット表現)のFNV-1aで、対局の並び順・seed・subset指定に非依存。`split_early_stop_validation`(L233-250)は `hash % 1_000_000 < round(percent×10^4)` の閾値判定で、決定性・順序非依存性の両方がテストで確認されている。frozen holdout(末尾10%)はON経路でもOFF経路と同一の切り方(L1010-1016)で、選択には一切使わず報告専用のまま(要件2の「選択バイアスを入れない」を満たす)。
- **縁ケース**: val-percent 0/100 はCLIで `(0,100)` 開区間チェックにより拒否(L1190)。極小percentでval側が空になった場合・train側が空になった場合はそれぞれ明示エラー(L1019-1030)。patience<1・max-epochs<1 も拒否。val_mae が NaN になる病的ケースでも `NaN < best` は常にfalseなので誤ってベスト採用されず、staleが積まれて停止する(1エポック目からNaNで `best.bin` が一度も書かれない場合は L973 の明示エラーで落ちる — 無言で壊れた重みを出すことはない)。

## 観点3: resume の健全性 — 概ね堅牢、1点だけ脆い窓あり(中1)

- identity検証: 最終bin・checkpointとも `verify_identity`(meta照合)を通し、さらに `state.epoch == checkpoint_epoch` の突合(L878-882)で checkpoint/state の食い違いを検出する。identity(schema=5-earlystop)には data_hash・config・seed・max_epochs・patience・val_percent・split件数・サンプル数が全て入っており(L1095-1105)、データや設定が変わったrunへの誤resumeは構造的に不可能。
- 書き込みは全て `atomic_write`(tmp+MoveFileExW/rename)。エポック内の書き込み順は「best.bin → metricsの行追記 → checkpoint → state.txt → 旧checkpoint削除」。各クラッシュ窓を検討した:
  - best.bin書き込み直後(state未更新)のクラッシュ: resumeは前エポックのcheckpoint+stateから当該エポックを決定的に再実行し、同じ判定で同じ `best.bin` を再保存する。学習が決定的(シャッフルは start_epoch 由来、regression.rs)なので不整合は残らない。**安全**。
  - metrics行追記後・checkpoint前: `truncate_early_stop_metrics_after`(L907)が余分な行を切り詰める。**安全**。
  - 最終bin保存のmeta/bin間、finalize前後: 最終binが完成していなければcheckpoint経路で再開して直ちにfinalizeし、完成していれば skip 経路(L852-872)が結果報告だけやり直す。**安全**。
- **【中1】checkpoint保存後・state.txt書き込み前のクラッシュで resume が手動介入必須になる**: この窓では `latest_checkpoint` = epoch N、`state.epoch` = N-1 となり、L878-882 で「checkpoint epoch mismatch」の恒久エラーになる(旧checkpoint epoch-(N-1) はまだ削除されていないのに、フォールバックせずエラーで止まる)。誤った状態で走り続けるのではなく明示エラーで止まる設計なので安全性の問題ではないが、T160のような長時間runでは「epoch-N.bin(.meta) を手で消せば再開できる」ことを運用手順として知っておく必要がある。改善案(任意): mismatch時に `state.epoch` と一致する古いcheckpointが存在すればそちらへフォールバックする、またはエラーメッセージに復旧手順(最新checkpointの削除)を含める。

## 観点4: テストの独立検証性 — 良好

自己参照(実装をなぞるだけ)のテストは無い。特に:

- `off_path_matches_direct_model_training_bit_for_bit`: 期待値を `Model::train`(一括学習)で独立生成し、`run_config_seed`(エポック分割+checkpoint経路)の出力バイト列と比較。**OFF経路の学習挙動が変わればバイト不一致で検知できる実効的な回帰ガード**。ただしこのテストが守るのは `run_config_seed` までで、`main` のディスパッチ(early_stopが誤って既定ONになる等の退行)は自動テストの範囲外(軽微5)。
- `early_stop_restores_best_checkpoint_and_stops_before_max_epochs`: train/valの教師値を逆方向(+10/-10)にして「valが単調悪化する」シナリオを構成し、最終成果物を**独立に再学習した1エポック目モデルのバイト列**と比較。ベスト復元の直接証拠になっており良い設計。
- `early_stop_resume_matches_uninterrupted_run`: 期待値は中断なし実行(独立系列)で、クラッシュ状態はファイル直接書き込みで再現。resume系テストとして妥当。ただし再現しているのは「エポック完了直後」という最もクリーンな断面のみで、観点3の脆い窓(checkpoint後state前)は未テスト(軽微6)。
- split決定性・順序非依存・patience純粋関数テストも期待値を手計算/独立列挙で書いており健全。

## 観点5: T160(Egaroucid全量)への適合性 — 併用ガード確認OK、T159bへの所見

- `--simple-corpus` + `--early-stop` の併用は L1180-1183 で明示エラーになることを確認(「対局概念を持たない簡易コーパス経路とは組み合わせられない」というコメント付き)。黙って無視ではなくエラーなのは正しい。**つまり現状のままではT160(Egaroucid 25.5M = simple-corpus経路)で早期打ち切りは使えず、T159bが必須**(タスクfrontmatterの認識どおり。オーケストレーターの仕様把握も正)。
- T159b設計への所見(拡張時の障害):
  1. **分割単位**: game概念が無いため検証splitは局面単位にせざるを得ない(既存 `simple_corpus::split_by_position_hash` と同型のハッシュ分割が素直)。ただしEgaroucidデータに同一ライン由来の相関局面が含まれる場合、train/valに近縁局面が跨ってval MAEが楽観側に歪み、早期打ち切りシグナルが鈍る可能性がある。ソースファイル単位・行ブロック単位などの粗い分割で代替できないか検討する価値あり。
  2. **メモリ**: 現WTHOR実装の `split_early_stop_validation` は全対局を clone し(L244-247)、さらに flatten でサンプル列も複製するため、ピークで元データの約3倍を保持する。25.5M局面(1サンプル数十バイト)では数GB規模になるので、simple-corpus版では**インデックス分割 or その場パーティション**(cloneしない)に設計変更すべき。
  3. **エポックあたりの追加評価コスト**(中2参照): 25.5Mではtrain_mse/train_mae/val_maeの3パスが支配的コストになり得る。
  4. **identity**: `schema=2-simple` とは別の新schema(corpus_hash + ES全パラメータ入り)が必要。reservoir sampling(`--simple-max-records`)後のpoolに対して分割する場合、分割の決定性はpoolの決定性(corpus_hash+seed)に載る点をidentityに反映すること。
  5. B3特徴(t158系config)はWTHOR split必須のガードがあるため、Egaroucid+B3をやるならそのガードとの関係も整理が要る(T160のconfig計画次第)。

## 観点6: val_samples > train_samples(180kスモークの 198,595 > 179,974)の妥当性 — 問題なし

原因は明確: 検証split(全対局の5% ≒ 3,316対局 ≒ 198,595局面)はサブセット化されず全量使う一方、train側は `--train-subset-size 180000` で層化サブセット化されるため。これは**スモーク特有の逆転**であり、統計的には「val側が大きい=監視指標のノイズが小さい」だけで選択バイアスは生じない。設計として正しい。エポック時間への影響は「毎エポック198k局面の予測1パス」で、180k学習+180k×2(mse/mae別パス)評価と同オーダーの追加。全量run(サブセット無し)ではvalはtrainの約5.3%に過ぎず無視できる。対応不要(スモークを高速化したい場合にval側の任意サブサンプル化を検討する程度)。

---

## 指摘一覧

### 重大(ブロッカー)
なし。

### 中
1. **resume脆弱窓**(L878-882): checkpoint保存後・state.txt書き込み前のクラッシュで「checkpoint epoch mismatch」の恒久エラーになり、最新 `epoch-N.bin`/`.meta` の手動削除まで再開不能。旧checkpointが残存しているためフォールバック実装は可能。T160長時間runの運用手順として申し送り推奨(挙動自体はfail-safeなのでredo不要)。
2. **エポックあたりの評価コスト**: 毎エポック `mean_squared_error`(train全量)+`mean_absolute_error`(train全量)+`mean_absolute_error`(val全量)の3フルパス(L925-927)。mse/maeは1パスに統合可能で、大規模データではtrainメトリクスを固定サブサンプルにする選択肢もある。T159b/T160の所要時間見積りに織り込むこと。
3. **メモリ設計**(L233-250, L1032-1033): 対局cloneによる分割+flattenで元データの約3倍を保持。WTHOR 4.4Mでは実害軽微だが、25.5M向けのT159bではインデックスベース分割に変更すべき(設計材料)。

### 軽微
4. **`append_result_earlystop` の重複判定キーがプレフィックス衝突する**(L350-351): キー `"v3\t1"` が既存行 `"v3\t12\t..."` にも前方一致するため、seed 12 の結果が先にある状態で seed 1 を追記すると黙って捨てられる。既存 `append_result`(L330-331)から複製された既知パターンで T159 の退行ではない。両関数とも `starts_with(&format!("{key}\t"))` にすべき(通常のseed 1,2,3運用では発火しない)。
5. **`main` ディスパッチの自動テスト不在**: OFF既定の分岐(L1155, L1289)自体はユニットテストで守られておらず、長期的なOFF不変の担保は `run_config_seed` レベルのビット一致テスト+今回の一度きりのSHA比較に依存する。CLIプロセス起動型のスモークテストがあれば理想(現状でも受け入れ基準は満たす)。
6. **ダーティなクラッシュ断面のresumeテスト不在**: resumeテストはエポック完了直後の断面のみ。中1の窓や「metrics余分行あり」断面(truncate経路)は未テスト。
7. **ON経路のt158 configで `feature-distribution.json` の内容が微妙に変わる**(L1035-1042): 分布計算の母集団がOFF経路の「train 90%」ではなく「ES-train 85.5%」になり、同一output_dirでOFF/ON両方を走らせると同名ファイルを相互上書きする。JSON内の `split` 説明文(L626)もES経路では不正確。実害はほぼ無い。
8. **新フラグの黙殺**: `--early-stop-val-percent` / `--early-stop-patience` / `--max-epochs` は `--early-stop` 無しだと黙って無視される(`--simple-max-records` には依存ガードがあるのと非対称)。逆に `--epochs` はON時に黙って無視されるため、`--epochs 30 --early-stop` と打ったユーザーは既定 `--max-epochs 20` で走っていることに気づきにくい。警告かエラーの追加を推奨。
9. **完了後の孤児checkpoint**: 最終bin保存後・checkpoint削除前にクラッシュすると、skip経路はcheckpointを掃除しないため `epoch-XX.bin` が恒久残存する(state書き込み後・旧checkpoint削除前のクラッシュでも1個リーク)。成果物の正しさには影響しない。
10. **OFF時でも新フラグ値をeagerに `.parse().unwrap()`**(L1156-1158): 不正値を渡した場合のみOFF挙動が「無視」から「panic」に変わる。既存フラグと同じ流儀であり許容。

## 結論

要件1〜7はコード上すべて満たされている。OFF経路の不変性は「純挿入差分+成果物名前空間の分離+別schema+等価性テスト+SHA実証」の多重担保で高い確度がある。指摘はすべて非ブロッカー。**合格**。中1〜3(特にT159bのメモリ/評価コスト/分割単位)と軽微4・8をSTATUS.mdの申し送りまたはT159b設計依頼書に反映することを推奨する。
