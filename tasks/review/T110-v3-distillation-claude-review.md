# T110 最終レビュー(Claude代替、Codex週間上限期間中)

- 対象: コミット `84539a5`(`train/src/t090_distillation.rs`、+183/-14)
- タスク仕様: `tasks/T110-v3-distillation.md`
- レビュー方法: 静的コードレビュー(読み取り専用)。T104が並行実行中のため `cargo test` の
  再実行は行わず(不要な再ビルド・CPU負荷の回避、タスクの並行実行注記に準拠)、ワーカー報告の
  テスト結果(train 59件パス)とSHA-256等価性の実測報告を前提に、コード上の裏取りを行った。
- 確認済み: `84539a5` は当該ファイルへの最新コミットで、working tree とも一致(`git status` の
  差分は T104 由来の `engine/src/endgame.rs` `engine/src/search.rs` と `tasks/` のみ)。
  蒸留トレーナー本体のほか、依存先の `train/src/regression.rs`(Model)、
  `engine/src/pattern_eval.rs`(PWV2/PWV3入出力)、`engine/src/patterns.rs`(V3定義)、
  `engine/src/bin/eval_cli.rs`・`bench/edax-compare/compare_pattern_v3.py`(oracle採点経路)を照合した。

## 総合判定: **合格**

実験結論(v3×蒸留 oracle regret 2.67、表現力仮説の部分支持)を覆しうる重大バグは発見できなかった。
中2件・軽微数件のみ(いずれも申し送りで足り、redo不要)。

---

## 重点1: `--pattern-set v2|v3` の実装 — 問題なし

**無指定時の完全等価性(コードパス)**: `parse_pattern_set(None)` と `Some("v2")` は同一の
`PatternSet::V2` に落ち、`patterns_for(V2)` は従来の `patterns::generate_patterns()` をそのまま
呼ぶ。`run_one` の変更点は `Model::new(patterns::generate_patterns())` →
`Model::new(patterns_for(pattern_set))` のみで、V2では引数まで含めて完全に同一。
`pattern_set_identity_line(V2)` は空文字列なので identity 文字列も従来と不変
(T109 の `train_subset_size` と同じ「既定値では追加しない」流儀で一貫)。
`ensure_metrics_header` は「ファイル無し→現行ヘッダで新規作成」「現行ヘッダ一致→無変更」で、
旧コードの `if !exists { write header }` と正常系で等価(相違は旧ヘッダ拒否という意図された
新挙動のみ)。ワーカー報告の smoke SHA-256 一致(`a9f60406…`、T095/T109記載値とも一致)は
このコード構造と整合する。

**v3選択時のT087定義の利用**: `patterns_for(V3)` は
`patterns::generate_patterns_for(patterns::PatternConfig::V3)` を直接呼ぶ。engine側の実装は
v2の22インスタンス + `edge2x_patterns()` + `diagonal_offset_patterns()`(5/6/7対角オフセット)で
38インスタンス、`compute_pattern_classes` で10クラス — T087の定義そのもの(engine/ は無変更で
読み取り利用のみ、タスクのスコープどおり)。新テスト
`patterns_for_v3_has_more_instances_and_classes_than_v2` が 22/38・6/10 をピン留めしており、
ワーカー報告の `to_bytes_v3()` 5,964,708バイト(T087一致)とも整合する。

## 重点2: resume identity の分離 — 問題なし

`run_one` の identity は `schema=4\n{identity_base}mix=…seed=…max_epochs=…l2=…` の厳密文字列
一致で照合され、`identity_base` 末尾に `pattern_set_identity_line` が入る。したがって:

- **v3 dir を v2(無指定)で resume** → 計算した identity に `pattern_set=v3\n` が無く不一致 → 拒否。
- **v2 dir を v3 で resume** → 計算側にだけ行が付き不一致 → 拒否。
- 双方向とも既存の `run identity mismatch … refusing resume` で確実に止まる(ワーカーが
  v3→無指定の方向を実地確認済み。逆方向もコード上同じ比較で対称に成立)。

**既存checkpointとの互換性**: `schema=4` は据え置き(バンプせず追加行方式)なので、
現行フォーマットのv2 run dir(T109以降)は従来どおり resume 可能。T109以前の旧 run dir は
identity は一致するが M1 のヘッダ検証で拒否される — これは意図された新挙動(下記)。
identity.txt はチェックポイント(`epoch-*.bin`/`.state` ペア)より先に書かれるため、
「checkpointはあるがidentityが無い」中途状態は生じない。

## 重点3: M1修正(`ensure_metrics_header`)— 3経路とも正しい(順序に軽微な指摘)

- **新規作成**: `!path.exists()` → `atomic_write` で現行ヘッダのみ書く。旧コードと同一バイト列。
- **一致時無変更**: 1行目が `METRICS_HEADER` と厳密一致なら読み取りのみで `Ok`(書き込みなし)。
- **旧ヘッダ拒否**: 不一致なら期待/実際のヘッダを含む明確な `Err` で停止。ヘッダ定数(7列:
  `epoch…train_teacher_mae…validation_ranking_mae`)はループ内のデータ行書式(7値、同順)と一致。
  空ファイル(0バイト)はヘッダ""扱いで拒否(安全側)。新テスト3件が3経路を過不足なくカバーし、
  ワーカーは実T090b dir(6列旧ヘッダ)での拒否も実地確認している。

**[中M1'] 拒否経路が完全には副作用フリーでない**: `run_one` では
`truncate_metrics_after(&metrics_path, epoch)`(t090_distillation.rs:984)が
`ensure_metrics_header`(:989)より**先に**実行される。旧ヘッダ dir を誤って resume した場合、
ヘッダ検証で拒否される前に metrics.tsv が書き戻され(通常は内容同一だが、最新checkpointより
新しいepoch行や重複epoch行があればここで削除される)、identity.txt も同内容で再書き込みされる。
「refusing to resume」と言いつつ対象dirへ書き込みが発生しうるのは M1 修正の意図
(不適合dirに手を付けず停止)と微妙にずれる。2呼び出しの順序を入れ替えるだけで解消する。
**実験結論への影響: なし**(本タスクの実行では新規dirのみ使用)。申し送りで足りる。

## 重点4: 学習初期化はv2蒸留(T090b)と同条件 — 作業ログの主張をコード上で確認

`--reference-weights`(既定 `train/weights/pattern_v2.bin`)から作る `reference` モデルの
使用箇所は2つだけ: (a) `load_corpus` 内の `engine_choice` 選定(:516-524、ranking pair用)、
(b) `reference.tsv` / reference frozen metrics の基準値算出(:1313-1317)。
学習対象は `Model::new(patterns_for(pattern_set))` = `PatternWeights::zeroed`(regression.rs:81-85)
で常にゼロ初期化、resume時のみcheckpointからロード。**reference が学習初期値に流れる経路は
存在しない**。v2蒸留(T090b)と全く同じ初期化流儀であり、作業ログの説明は正確。
なお reference は pattern_set に関わらず PWV2 固定なので、v2/v3 で `engine_choice`(ranking
pairの構成)も同一になる — これは重点6の公平性にも効く(後述)。

## 重点5: v3でのfeature抽出・PWV3書き出し・oracle採点の整合 — 問題なし

- **feature抽出**: `features()`(:568-577)・`train_step`・`metrics`・`child_score` はすべて
  `model.weights.patterns.len()` と `class_info`(`class_of`/`aligned_cells`)を走査する汎用実装で、
  22/38・6/10 のどちらでも同じ意味論。勾配は `HashMap<Feature, f32>` に集約してから適用するため、
  同一セルに複数インスタンスが落ちる場合の扱いも v2/v3 で一貫。`stage_for_empty_count` は共有。
- **PWV3書き出し**: checkpoint/best.bin/final.bin は従来から(T110以前から)`to_bytes_v3()` で
  自己記述形式 PWV3 に書かれており(:1012, :1040, :1058)、本コミットは書き出し経路を変えていない
  (v2既定のSHA一致がこれを裏付ける)。PWV3 はインスタンス定義・class_id・schema hash を
  埋め込み、ローダ(`from_bytes_v3`)が `compute_pattern_classes` の再計算と突き合わせて検証する
  ため、38インスタンス/10クラスの重みが壊れて読まれる余地は構造的に小さい。
- **oracle採点への受け渡し**: `compare_pattern_v3.py` は候補重みパスをそのまま
  `eval_cli best --depth 8 --exact-from-empties 0 --pattern-weights <path>` に渡し(:46-49)、
  eval_cli は `PatternWeights::from_bytes`(マジックバイト判別)でロードする。PWV3 候補は
  そのまま正しく評価される。regret 計算(oracleScore − moveValue、手番符号反転 :151-152)は
  候補に依存しない共通経路。局面単位の `atomic_json` 逐次保存・resume(:125-141)も要件どおり。
- v3×蒸留 3seed が同一regretになった件は、`final.bin` のSHA相違と frozen agreement の差から
  「60局面上でargmaxが偶然一致した」というワーカーの説明が最も自然で、コード上も
  キャッシュ混線を起こす経路(結果ファイルはseedごとに別ファイル)は見当たらない。

## 重点6: v3×蒸留 vs v2×蒸留の比較の公平性 — コード上は担保、計測再利用に中1件

**コード上の統制**: 両構成の差は `patterns_for(pattern_set)` ただ1点。
(a) コーパス: 同一 `load_corpus`(reference固定のため `engine_choice`/ranking pairも同一)、
(b) split: `key_hash(canonicalKey)%100`(:1259-1263、pattern_set非依存)、
(c) mix: baseline の係数解釈は共通 `Mix::parse`、
(d) early stopping: `stale>=5`・patience 0.02・LR半減(since_decay>=2)・max_epochs 60 とも共通、
(e) epochシャッフル: `shuffle(train.len(), seed^epoch)` は train长同一なら同一順列。
v2側参照値(T109/T090b実測)の流用は、v2経路が本コミットでビット同一(SHA-256一致)と
確認されているため妥当。

**[中M2] oracle計測の再現性の担保が「作業ツリー状態」に依存**: oracle採点に使った
`eval_cli.exe` は T104 の未コミットWIP(`engine/src/endgame.rs`/`search.rs`)を含むビルドで、
`evalCliSha256` はどのコミットからも再現できない。また比較表の v2×蒸留行(3.4667、CI)は
T109当時の別バイナリでの計測値の流用である。緩和材料はワーカーが開示済みで、コード上も裏が取れる:
`--exact-from-empties 0` は exact/shallow ソルバー経路を発火させないガード値であり、
同一セッションで再計測した v2×WTHOR 行が過去値 1.5667 に完全一致した(depth-8手選択が
バイナリ間で不変である強い実証)。4行すべての候補行は同一バイナリ・同一oracle値でペア比較
されているため、**結論を覆す性質のものではない**が、再現性の注記として申し送りする
(理想は当該コミットのクリーンビルドでの計測)。

**[軽微] seed2/3・v3×WTHOR行の oracleRows/v2行再利用は未コミットのscratchpadスクリプト経由**:
`compare_pattern_v3.py` の resume identity 検査(metadata完全一致)は candidateSha256 を含むため、
再利用には合成metadataで事前状態を作る必要があり、そのスクリプトはレビュー不能(未コミット)。
ただし主結論を支える seed1 はコミット済みスクリプトのフルスクラッチ実行であり、
seed2/3 は seed1 と同一regret(候補行は新規計測)なので、実害の可能性は低い。

---

## その他の指摘

- **[軽微] manifest.txt/stdout への無条件 `pattern_set=v2` 行追加**: 要件1の
  「無指定時は既存動作と完全等価」を出力ファイルまで字義どおり読むと、`manifest.txt` の内容は
  無指定時にも1行増えている。manifest は resume 判定に使われず(判定は identity.txt のみ)、
  重み・identity・metrics は不変(SHA一致で実証)なので実質問題なし。作業ログでも開示済み。
- **[軽微] identity不一致エラーが差分内容を示さない**: `run identity mismatch for {mix}` は
  既存挙動だが、pattern-set取り違え時に「何が違うか」が分からない。期待/実際の identity
  (または不一致行)をメッセージに含めると診断しやすい。
- **[軽微] `parse_pattern_set` は小文字厳密一致のみ**(`V3`・前後空白は拒否)。エラーメッセージは
  明確で、実験用CLIとしては許容範囲。
- テスト6件は作業ログの記述どおりの内容で、M1の否定テスト(旧6列ヘッダ拒否)・v3の
  インスタンス/クラス数ピン留め・identity行の分離を過不足なくカバーしている。
- 要件2の参考構成(T087重み初期値のfine-tune)省略は、`--init-weights` 相当の新規実装が必要という
  理由がコード上も正しく(初期化はゼロ固定で差し替え口が無い)、要件文言の許容範囲内。

## 結論

- 重大: **0件**
- 中: **2件**(M1': 拒否経路の副作用=truncateがヘッダ検証より先 / M2: oracle計測バイナリの
  再現性が未コミットWIP込み作業ツリーに依存+v2×蒸留行の別バイナリ計測値流用。いずれも
  実験のペア比較の内的整合性は保たれており、regret 2.67 という結論を覆さない)
- 軽微: 4件(manifest行追加の字義的非等価、identityエラーの情報量、CLI値の厳密一致、
  scratchpad再利用スクリプトのレビュー不能性)

**総合: 合格**(中2件は STATUS.md への申し送りで足りる。redo不要)
