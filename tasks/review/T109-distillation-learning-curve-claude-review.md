# T109 最終レビュー(Claude代替、Codex週間上限期間中)

- 対象: コミット `675f67a`(`train/src/t090_distillation.rs`、+321/-9)
- タスク仕様: `tasks/T109-distillation-learning-curve.md`
- レビュー方法: 静的コードレビュー(読み取り専用)。T104が並行してNPS計測中のため、
  `cargo test` の再実行は行わず(不要な再ビルド・CPU負荷の回避、CLAUDE.md/タスクの並行実行注記に準拠)、
  ワーカー報告のテスト結果(train 47件パス)とSHA-256等価性の実測報告を前提に、コード上の裏取りを行った。
- 確認済み: `675f67a` 以降このファイルへの変更コミットはなく、working tree とも一致(レビュー対象=現物)。

## 総合判定: **合格**

実験結論(「量仮説は支持されない」)を覆しうる重大バグは発見できなかった。
中程度1件・軽微数件のみ(いずれも申し送りで足り、redo不要)。

---

## 重点1: `select_train_subset` の入れ子性・層化の正しさ — 問題なし

入れ子性(小さいtargetの選択 ⊆ 大きいtargetの選択)の成立条件をコード上で精査した:

1. **phase分割はtargetに非依存**: `by_phase` は full train split 全体を
   `stage_for_empty_count(empty_count)`(空きマス5個/帯、`NUM_STAGES=13`)で分けるだけで、
   `target` は関与しない。各 `group` の内容・件数はサイズ間で同一。
2. **基準順はtargetに非依存かつ一意**: `group.sort_by_key(records[index].key)` は
   canonical key 順。key の一意性は `load_corpus` が重複 canonicalKey を即 Err で拒否する
   (t090_distillation.rs:405-407)ため保証されており、ソート結果はコーパスの行順にすら依存しない。
3. **シャッフル順列はtargetに非依存**: `shuffle(group.len(), phase_seed)` の入力は
   `group.len()`(固定)と `subset_seed_for_phase(seed, phase)`(subset_seed と phase のみの関数)。
   よって同一 seed なら全サイズで同一順列。
4. **cutpointはtargetの単調非減少関数**: `floor(target * group_len / total)`(u128演算でオーバーフローなし)。
   固定順列の接頭辞を伸ばすだけなので、フェーズごとに小target選択 ⊂ 大target選択、
   その和集合も入れ子。**入れ子性は数学的に成立している**(ワーカーの主張どおり)。

層化: floor配分により各phaseの構成比は元分布と一致(切り捨て誤差のみ)。合計の不足は
非空phase数(≤13)未満で、実測 6245/12494/24994(target 6250/12500/25000)と整合。
テスト4件(全量返却・決定性・入れ子・floor比率)は主張どおりの性質を検証している。
`fixture_record` の phase→empty_count 変換(`filled=64-phase*5` → empty=phase*5 → stage=phase)も正しい。

補足(バグではない): `count < total/target` の極小phaseは cutpoint=0 で小サブセットから
完全に落ちる。floor層化の性質として妥当で、残余の再配分(largest remainder等)を
しなかったのは入れ子性維持のため正しい判断。

## 重点2: `--train-subset-size` 無指定時の等価性 — 問題なし(コード上も確認)

- 無指定時 `train_subset_size=None` → `select_train_subset` は**呼ばれもしない**
  (t090_distillation.rs:1195-1205)。train/validation/frozen は従来と同一。
- **resume identity は無指定時バイト完全一致**: `subset_identity` は None で空文字列
  (1236-1239)、`identity` フォーマットの他部分は不変。既存run dirのresume互換を壊さない。
  run_one 側の `schema=4` も不変。
- `manifest.txt` には無指定時も `train_subset_size_target=full\ntrain_full_size=N` 行が
  追加されるが、manifest は書き出し・表示のみで**どこからも読み比較されない**ため挙動に影響なし。
- 学習経路: epoch シャッフルは `shuffle(train.len(), seed ^ epoch)` で train.len() と seed のみに依存、
  train_step は変更なし。追加された `train_metrics = metrics(&model, train, mix)` は純粋関数
  (重点3)。**重みバイト列が変わる経路は存在せず**、ワーカーのSHA-256一致実測
  (smoke・full/seed2 の final.bin が T090b と一致)とコード解析が整合する。

## 重点3: `train_teacher_mae` の forward-only 性 — 問題なし

- `metrics(model: &Model, ...)` は `&Model`(不変借用)のみで、重み更新・グローバル状態・
  乱数消費が一切ない純粋関数(652-705)。本プログラムに乱数「状態」は存在せず、
  xorshift は呼び出しごとに seed から決定的に生成されるため、呼び出し回数の増加が
  他の乱数列に影響する余地もない。
- early stopping 判定(`absolute_best`/`meaningful`)・LR減衰・best.bin 保存は
  従来どおり `validation_metrics` のみを参照(941-959)。train_metrics は metrics.tsv /
  result.tsv への記録専用。**学習に影響しない。**
- 完走後の result.tsv 用 `metrics(&best_model, train, mix)`(988)も同様に純粋。
- 仕様の「固定サブサンプル5,000で可」に対し全件計測を選択(毎epoch +train全件のforward)。
  計算コスト増のみで正しさに影響なし、作業ログにも明記あり。

## 重点4: T095申し送り3修正 — 実装正しい、抜けなし

- **(a) checked arithmetic**: `OUTCOME_ENTRY_BYTES=21`・`TEST_ENTRY_BYTES=23` は
  `encode_outcome_cache`/`push_sample` の実書き出しバイト数と一致することを照合済み。
  `checked_mul`/`checked_add` → 残りバイト数との下限照合(283)を `with_capacity` の**前**に
  実施しており、`outcome_count ≤ file_len/21` が保証されるため確保量はファイル実サイズで
  上界される。オーバーフロー系・過大件数系のテスト2件は狙いどおり
  (`cache_size_overflow` / `truncated_cache` を with_capacity 到達前に返す)。
  末尾の `trailing_bytes` 検査(325)も従来どおり残っており、下限チェックのみで十分。
- **(b) mix/seed重複拒否**: `find_duplicate_mix`(name比較。Mixは固定3種のenumなので
  name一致=構成一致)・`find_duplicate_seed` を run 開始前(load より前)に実施し
  FAILURE 終了(1082-1101)。同一checkpoint dirへの競合書き込み防止として十分。テスト2件あり。
- **(c) キャッシュ保存失敗のwarning化**: `load_outcomes` の `atomic_write(...)?` を
  `save_cache_best_effort`(warning + 続行)に置換(369)。メモリ上の outcomes/test で
  続行できるため学習は正常完了する。テスト1件(存在しないディレクトリでpanicしない)あり。

## 重点5: 実験結論に影響しうるバグ — なし

- **サブセットのvalidation/frozenへの漏れ**: 構造的に不可能。split は
  `key_hash % 100`(0-89/90-94/95-99)の分割(1183-1189)で互いに素、サブセット化は
  分割**後**の train のみに適用(1195-1205)、validation/frozen 変数は無変更。
- **seed処理**: `--subset-seed`(既定42)は学習seed(`--seeds`)と独立。
  `subset_seed_for_phase` は FNV で phase ごとに独立 seed を導出(`phase as u8` は
  NUM_STAGES=13<256 で安全)。identity にサブセット指定時のみ target/seed が入るため、
  異なるサイズ・seed の checkpoint dir 取り違え resume は identity mismatch で拒否される。
- `train_size` 列は floor 後の実件数(`train.len()`)を記録しており、報告表の
  6245/12494/24994/45055 と整合。
- `--train-subset-size 0` は明示拒否、全phaseで cutpoint=0 になった場合の空trainも
  明示拒否(1201-1204)。

## 指摘事項

### 重大(実験結論を覆しうる): なし

### 中: 1件

- **[M1] 旧(T109以前)run dirをresumeすると metrics.tsv の列がずれる。**
  無指定時 identity は不変なので旧full run dirのresumeは許可されるが、
  `truncate_metrics_after` は既存ヘッダ(6列)を温存し、新コードは7フィールドの行を
  追記する(919-922 のヘッダ書き込みは「ファイルが無い場合のみ」)。旧dirをresumeした場合、
  ヘッダと行のフィールド数が不一致になり、列名で読む解析ツールが
  `train_teacher_mae` の値を `validation_loss` と誤読しうる。
  **T109の実験自体は全run新規dirのため影響なし**(結論には無関係)。
  申し送り: 旧dirはresumeせず新dirで走らせるか、次回このファイルを触るタスクで
  「ヘッダのフィールド数検証(不一致なら identity mismatch 同様に拒否 or ヘッダ再生成)」を追加。

### 軽微

- **[L1]** 極小phase(件数 < total/target)は小サブセットで0件になる(floor層化の仕様上の帰結。
  ドキュメントコメントには「合計がtargetよりわずかに少なくなる」旨のみ記載)。実害なし。
- **[L2]** 毎epochのtrain全件MAE計測は、大きなtrainではepoch時間をほぼ倍化させる
  (forward 2回分)。仕様が許す固定5,000サブサンプルへの切替余地あり。正しさに影響なし。
- **[L3]** 作業ログの「新規8件」は実際には新規テスト9件(subset系4+decode系2+cache保存1+重複拒否2)。
  記録上の軽微な不一致のみ。
- **[L4]** `atomic_write` は `replace_file` 失敗時に `.tmp` ファイルが残りうる(既存挙動、
  本コミットの変更対象外。(c)のwarning経路で顕在化しうるが gitignore 領域であり実害僅少)。

## 検証上の注記

- 本レビューは静的解析であり、テスト実行・SHA再計測は行っていない(T104のNPS計測との
  並行実行制約による)。無引数等価性は「変わる経路が存在しない」ことのコード裏取りと、
  ワーカー報告のSHA-256一致(smoke一致 + full/seed2 が T090b final.bin とバイト一致、
  後者は本実験の oracle regret 流用の妥当性も同時に裏付ける)の両面で確認した。
- コミット範囲は `train/src/t090_distillation.rs` のみで、engine・アプリ・本番重みへの
  変更は含まれない(仕様のスコープ外項目に抵触しない)。
