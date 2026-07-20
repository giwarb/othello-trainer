# T159b 最終レビュー: 早期打ち切りのsimple-corpus(Egaroucid)経路対応(Claude代替レビュー)

- 対象: コミット `fa448f0`(`train/src/bin/train_patterns_v3.rs` +853/-15、`train/src/regression.rs` +105、`train/src/simple_corpus.rs` +138)
- レビュアー: Claude Fable 5(Codex usage limit中の代替)
- 方式: `git diff fa448f0~1..fa448f0` の全差分精読 + fa448f0時点のファイル本文で共有ヘルパー(`ensure_early_stop_metrics_header` / `truncate_early_stop_metrics_after` / `split_by_position_hash` / `finalize_early_stop_result` / `parse_simple_line` / state読み書き)を照合 + `git diff fa448f0 HEAD -- train/` が空であることを確認。`cargo test -p train`(137件)を独立に再実行し全パスを確認。コードは無修正。
- 前提: T159レビュー `tasks/review/T159-trainer-early-stopping-claude-review.md`(中1=resume脆弱窓、中2=エポック評価コスト、中3=splitメモリ、軽微4=結果行キーのプレフィックス衝突、軽微8=--epochsの黙殺)。

## 総合判定: **合格**(重大 0 / 中 1 / 軽微 6)

重大(ブロッカー)指摘なし。T159レビューの中3件はいずれも実質的に解消されており、simple-corpus経路の早期打ち切りは分割・学習・resume・identityの全観点で健全。中1件(metrics旧ヘッダとのresume非互換)はfail-loudかつ影響母集団が実質空(下記)のためredo不要と判断し、STATUS.mdへの申し送りを推奨する。

---

## 観点1: 既存経路の不変 — 確認OK(1点だけ互換性の注意あり=中1)

### OFF経路(WTHOR / simple-corpus 両方)

- `main` の変更は4点のみで、いずれもOFF時の実行パスに副作用がない:
  (a) T159併用ガードの削除(`--early-stop`且つ`--simple-corpus`時のみ到達していたブロック。OFF時は元々通らない)
  (b) `--epochs`+`--early-stop`併用時の警告(early-stopバリデーションブロック内、ON時のみ)
  (c) simple-corpus分岐内の `if early_stop { return run_early_stop_simple_corpus(...) }`(OFF時は条件評価のみ)
  (d) `append_result_earlystop` のキー修正(earlystop専用ファイルのみ。OFF経路の `append_result` は意図的に無変更 — OFF不変を優先した判断として正しい)
- `run_config_seed` / `split_by_position_hash` / `load_simple_corpus` / identity(schema=2 / 2-simple / 3-t158)はいずれも無変更。
- 実証: stash前後SHA-256一致がWTHOR OFF(`5228350a...`、T159時点の記録値とも一致)とsimple-corpus OFF(`f7508ab5...`)の両方で取られている。加えて新テスト `simple_corpus_off_path_matches_direct_model_training_bit_for_bit` が `load_simple_corpus`→`split_by_position_hash`→`run_config_seed` の経路を `Model::train` 直接呼び出しとバイト比較しており、T159の等価性テストと同型の実効的な回帰ガードになっている。

### WTHOR早期打ち切りON経路(T159実装への影響)

変更は2点のみ: (i) resume時の突合を「等号一致のみ・即エラー」から共有ヘルパー `recover_early_stop_state` に置換(正常時 `state.epoch == checkpoint_epoch` は従来と同一挙動で即Ok)、(ii) metricsを8列化(`best_epoch`/`best_val_mae` 追加)。重み計算・停止判定・成果物パス・identity(schema=5-earlystop)は無変更。作業ログのWTHOR ONスモーク(best_epoch=3, epochs_run=5, best/finalのSHA一致)で完走確認済み。

- **【中1】T159形式(6列ヘッダ)の既存metrics.tsvを持つ中断中runは、新コードでresumeできない**: `ensure_early_stop_metrics_header` は既存ファイルのヘッダを `EARLY_STOP_METRICS_HEADER` と**厳密一致**で照合し、不一致なら明示エラーで停止する(fa448f0時点の実装を確認)。ヘッダ定数が6列→8列に変わったため、T159時代に作られ**中断状態のまま**のrunを新バイナリでresumeすると「early-stop metrics header mismatch」で即エラーになる。緩和要因: (1) 完了済みrunの再実行はskip経路(`final_path.exists()`→identity照合→finalizeのみ)を通り、ヘッダ照合に到達しないため壊れない。(2) 現実の母集団はほぼ空 — T159の180kスモークは完走済み、T160はこれから新規実行。(3) 静かに壊れるのではなく明示エラーで、metrics.tsvを消せば(履歴行は失うが)続行可能。よってredo不要だが、**「T159形式のmetricsを持つ中断runはresume前にmetrics.tsvの削除が必要」をSTATUS.mdに申し送り**すること。なお旧6列「行」の混在自体も、recovery(`read_early_stop_metrics_row`)が8列厳密チェックで拒否するため静かな誤読は起きない(fail-closed)。

## 観点2: `split_for_early_stop` の正しさ — 確認OK

- **frozen判定の完全同一性**: frozen側ハッシュは `split_by_position_hash` と1文字単位で同一(FNV-1aオフセット基底 `0xcbf29ce484222325`、`key.0` LE→`key.1` LE→`[key.2]`、`%10==9`)であることをコード照合で確認。さらにテスト `split_for_early_stop_frozen_matches_split_by_position_hash` が同一poolでの**順序込み完全一致**を検証しており、frozen集合の意味(OFF経路との互換・学習データ非汚染)は保たれる。
- **val saltの独立性**: val側は初期値 `0x84222325_cbf29ce4`(オフセット基底の上下スワップ)の別FNVで、frozen判定通過後(非frozenのみ)に適用。数学的な独立性証明はないが、25.5M実測で val/(非frozen) = 1,114,591/22,324,705 = **4.99%**(指定5%)と設計どおりで、相関の兆候はない。
- **消費型分割のメモリ**: `records` の所有権を受け取り1パスで3つのVecへムーブ(clone皆無)。厳密には走査中は元Vecのバッファ+成長中の3分配Vecが同時に生きるため遷移的ピークは約2×だが(「追加メモリはほぼ発生しない」はやや楽観、軽微3)、T159のclone+flatten約3×からは確実に改善しており、25.5M実測Working Set 0.8〜1.2GBで実害なし。
- **D4対称重複**: canonicalKey(D4正規化)ベースなので対称重複は常に同一バケット。テスト `split_for_early_stop_keeps_symmetric_duplicates_in_the_same_bucket` は「3バケットのうち丁度1つに2件」を検証しており厳密。網羅性(train+val+frozen=全件)と決定性のテストもある。
- 対局境界が復元不可能である根拠(1行1局面・メタデータ皆無・隣接行の空きマス数がばらばら=生成時シャッフル済み)は実データ調査に基づき妥当。類似局面リークによる検証MAE楽観バイアス(停止が遅れる方向=fail-safe側)はコード内コメントと作業ログの両方に明記されており、要件1のフォールバック条件を満たす。
- 観察(指摘ではない): Egaroucid実データでのfrozen比率は約12.5%(3,189,392/25,514,097)で名目10%より高い。これは既存 `split_by_position_hash` のFNV mod 10特性由来でT159bの回帰ではない(frozen一致テストが既存との同一性を保証)。

## 観点3: `train_epoch_with_running_loss` の等価性 — 確認OK

- **テストは自己参照ではない**: `train_epoch_with_running_loss_updates_weights_identically_to_train_epochs` の期待値は既存本番コード `train_epochs`(T159b無変更)で独立生成し、3エポック分の重みバイト列一致を検証する。running loss集計の追加が更新系列を1ビットでも変えれば検知される実効的なガード。シャッフルは `shuffle_indices(len, cfg.seed ^ epoch)` で既存と同一系列。
- **running lossの定義**: 「各サンプル処理直前(更新前)の予測」による集計=オンラインSGDの標準的な学習中損失。エポック後フルパスとの相違はdocコメントに明記。停止判定は `val_mae`(真のフルパス)のみを使うため、この近似が早期打ち切りの挙動に影響することはない(train_mse/train_maeは記録用途のみ)。定義・用途とも妥当。
- 補足(軽微4): metrics.tsvの `train_mse`/`train_mae` 列は、WTHOR ON経路(学習後フルパス)とsimple経路(更新前オンライン集計)で**同名だが意味が異なる**。分析時の混同に注意(申し送りメモ推奨)。

## 観点4: `recover_early_stop_state` の回復ロジック — 確認OK(理論上の微小分岐1点=軽微1)

- 回復の正当性は書き込み順序の不変条件「best.bin → metrics行 → checkpoint → state.txt」に立脚する: checkpoint(epoch=N)が存在するならmetrics行Nは必ず書き込み済み。よって (a) state=N-1・checkpoint=N の窓、(b) state.txt欠落、の2断面のみをmetrics行から自己修復し、それ以外(2エポック以上のズレ)は手動復旧手順付きの明示エラー(fail-closed維持)。分類は網羅的で正しい。
- **best.binとの整合**: 窓内クラッシュ時、当該エポックがis_bestならbest.binはmetricsより前に書かれており、metrics行の `best_epoch`/`best_val_mae` と常に一致する。is_bestでなければbest.binは旧ベストのままでmetrics行もそれを指す。**誤った自己修復で静かに壊れるケースは構造上存在しない**。metrics行の重複も、resume冒頭の `truncate_early_stop_metrics_after` の呼び出し順序(「metrics行あり・checkpoint無し」断面ではstate一致branchで先に切り詰め)により発生しない。
- テストは単体3件(窓回復・state欠落回復・回復不能ギャップ拒否)+統合1件(`early_stop_resume_recovers_from_checkpoint_ahead_of_state_window`: 脆弱窓状態からのresumeが中断なし実行と最終バイト一致)で、T159レビュー軽微6(ダーティ断面テスト不在)も同時に解消している。
- **【軽微1】回復時のbest_val_mae精度ロス**: metrics行の `best_val_mae` は `{:.6}` 丸めで記録されるため、回復経路を通ったresumeではstate.txtに丸め値が書き戻され、以後の `val_mae < best_val_mae` 判定が非中断実行と最大5e-7の窓で分岐しうる(要件5「resumeが決定的に同一結果」の厳密性をこの経路のみ欠く)。発生には「脆弱窓クラッシュ」と「後続val_maeが丸め誤差窓内に落ちる」の重畳が必要で実務上無視でき、外れてもベスト選択が1e-6未満劣るだけ。恒久修正するならmetricsのbest_val_mae列を最短往復表現(`{}`)にすればよい。

## 観点5: T159レビュー中3件の対処完了度 — 3件とも解消

| T159指摘 | 対処 | 判定 |
|---|---|---|
| 中1: resume脆弱窓(checkpoint後state前クラッシュで恒久再開不能) | metrics 8列化+`recover_early_stop_state`(WTHOR経路にも共有)。回復不能ケースにも手動復旧手順をエラーメッセージに同梱(T159改善案の両方を実装) | **解消**(テスト4件) |
| 中2: エポック評価3フルパス | simple経路は`train_epoch_with_running_loss`でtrain損失を学習パス内集計、フルパスはval_maeの1回のみ。実測0.42秒/エポック(157k件)→全量59.5秒/エポックまで記録済み。WTHOR経路は仕様どおりスコープ外のまま | **解消**(simple経路について) |
| 中3: split時clone+flattenの約3×メモリ | 消費型1パス分割(clone皆無)。25.5M実測でWorking Set 0.8〜1.2GB | **解消** |

軽微4(結果行キーのプレフィックス衝突)はタブ込み前方一致に修正(earlystop側のみ、OFF側は不変維持のため意図的に非対処 — 妥当)、軽微8(`--epochs`黙殺)は警告化。いずれもタスク要件6のとおり。

## 観点6: T160への申し送り(t158系config+simple-corpus併用ガード)

- **ガードの場所**: `train/src/bin/train_patterns_v3.rs` の `main`、`--simple-corpus` 分岐冒頭のバリデーション群内 — `if configs.iter().any(|config| config.t158) { eprintln!("T158 configs require the WTHOR game split"); return ExitCode::FAILURE; }`(T155由来、本コミット無変更)。`--early-stop` の有無に関わらずB3(`t158-b3`)設定はsimple-corpusで実行不能であり、作業ログの「T160は素のv4構成しか実行できない」という申し送りは正確。
- **ガードを外す際の注意(重要)**: 単にガードを外しても**B3はEgaroucidデータで学習できない**。`parse_simple_line` はEgaroucid形式に手履歴情報が無いため `mover: Side::Black`・`last_move_kind: LastMoveKind::Other`・`vulnerable_xc: false` を全サンプルで固定しており、B3スカラー特徴の入力が完全に縮退する(勾配は流れるが全サンプル同値のため定数項の学習にしかならず、意味のある特徴重みが得られない)。加えて (a) `write_t158_metrics`/feature-distribution出力は `frozen_games`(対局リスト)を要求し、simple経路は空スライスしか渡せない、(b) t158系identityのfeature_schema整合、の2点も要調整。**結論: B3のEgaroucid学習は「ガード解除」ではなくデータ形式レベルの制約であり、T160計画はこの前提(素のv4のみ)で組むべき**。
- schema=6-earlystop-simple のidentityは corpus_hash・reservoir_seed(=`--subset-seed`、`load_simple_corpus`に渡る実シードであることを確認)・max_records・early-stop全パラメータ・3分割件数を含み、pool決定性への依存がT159レビュー観点5-4の指摘どおり正しく反映されている。

## 観点7: 実装者の自己申告逸脱(regression.rsへの追加) — 妥当

タスクの変更対象リストは `train_patterns_v3.rs` と `simple_corpus.rs` のみだが、要件3「train損失は学習パス中の逐次集計で代替」はSGDループ内部での集計を要求するため、`Model` にメソッドを追加する以外の実装は「binクレート側にSGD更新ロジックを複製する」ことになり、かえって等価性リスクが高い。追加は純増のみ(既存 `train`/`train_epochs`/`sgd_step` 無変更)で、bit-identityテストが等価性を担保しており、完了報告で申告済み。**逸脱として妥当**(タスク仕様側の記載漏れと判断)。

---

## 指摘一覧

### 重大(ブロッカー)
なし。

### 中
1. **metrics旧ヘッダ(T159形式6列)の中断中runは新コードでresume不能**(`ensure_early_stop_metrics_header` の厳密一致照合)。fail-loud・影響母集団は実質空・回避容易(metrics.tsv削除)のためredo不要。T159形式の中断runが万一残っている場合の復旧手順としてSTATUS.mdに申し送り推奨。

### 軽微
1. **回復経路のbest_val_mae丸め**(`{:.6}`): 脆弱窓からの回復後、非中断実行と最大5e-7窓で判定が分岐しうる(要件5の厳密性)。実害は無視可能。恒久修正はmetricsのbest_val_mae列を `{}` 表現にする。
2. **コメントへのキリル文字混入**: `simple_corpus.rs` テストモジュールの `diverse_lines` docコメントに「распределение」(=分布)が混入。動作影響なし、次に触るときに修正でよい。
3. **「追加メモリはほぼ発生しない」はやや楽観**: 消費型分割でも走査中は元Vecバッファ+3分配Vecで遷移的ピーク約2×。実測(0.8〜1.2GB@25.5M)で実害がないことは確認済み。docコメントの精度の問題のみ。
4. **metricsの `train_mse`/`train_mae` 列の意味がWTHOR ON経路(学習後フルパス)とsimple経路(更新前オンライン集計)で異なる**(同名列・同一ヘッダ)。停止判定はval_maeのみ使用のため実害なし。横断分析時の注意として申し送り。
5. **(d)テストの期待値生成が `train_epoch_with_running_loss` 自身**(`simple_corpus_early_stop_restores_best_checkpoint_and_stops_before_max_epochs`): 単体では自己参照気味だが、`train_epochs` とのbit-identityテストとの組で独立性は担保されており許容(T159の同型テストは `Model::train` で独立生成していたので、揃えるならそちらの流儀)。
6. **手動復旧ヒントの副作用**: 回復不能ギャップ時の「最新checkpoint削除」に従うと、保持checkpointは常時1個のため checkpoint が全滅しフレッシュ再開になるケースがある(best.bin/state/metricsは初回エポックで正しく上書きされるため成果物は壊れない)。運用知識として記録。

## 結論

タスク要件1〜8はコード・作業ログの両面で満たされている。T159レビューの中3件+軽微2件の対処は完全で、既存経路(OFF両方・WTHOR ON)の不変性は「純増差分+SHA実証×2+等価性テスト」で高い確度がある。中1(旧ヘッダresume非互換)は理論上の互換性欠落だがfail-loudかつ実影響がないため、申し送りのうえ **合格** とする。テスト137件(train)は本レビューで独立再実行し全パスを確認した。
