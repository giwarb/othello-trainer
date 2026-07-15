---
id: T095
title: 蒸留学習トレーナーの高速化(6run並列化・WTHORキャッシュ・重複計算排除)
status: done # todo | in_progress | review | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 0
---

# T095: 蒸留学習トレーナーの高速化

## 目的

今後の蒸留実験(oracle再判定後の再学習、v3×蒸留、200kコーパス)の反復を速くする。explorer調査(2026-07-15)で判明したトレーナー(`train/src/t090_distillation.rs` ほか)の非効率3点を潰す。**数値結果(学習される重み・指標)は変えない純粋な高速化**であり、等価性をテストで担保する。

## 背景(explorer調査の要点)

- 6run(mix×seed)は完全直列(`t090_distillation.rs:735-873` の二重forループ)。各runは独立Model・独立checkpoint dirで、共有は読み取り専用スライスのみ。rayon/thread使用は皆無。マシンは物理8コア/論理16スレッド。
- 起動時のWTHOR処理(`experiment.rs:44-57` `canonicalize()` を推定100万〜200万サンプルに適用)が**固定約20秒**。コーパスサイズ非依存で、smoke反復のたびに毎回払っている。
- `train_step`(`t090_distillation.rs:373-434`)の重複計算: 親局面で `features()` と `model.predict()` が同一の `pattern_state_index` を独立に2回計算。pairsループ内で best 側の `child_score`/勾配を毎回再計算(pairs全体で不変なのに最大3回)。実測で baseline(pairsあり)0.49秒/epoch vs teacher-only 0.105秒/epoch(45,055件)。
- クリーン実行の実測: 6run合計の純計算は約100秒。T090bログの「10〜30分」は環境負荷の混入。

## 要件

1. **6runの並列実行**: `std::thread::scope` 等で `run_one` を並列化する(既定の並列度は run 数と論理コアから安全側で決定、CLIで `--jobs` 指定可能に)。各runの決定性・checkpoint/resume・run identity検証は不変。**直列実行時と選択重み(best/final.bin)がバイト一致**すること。進捗ログはrunラベル付きで混在出力してよい。
2. **WTHOR outcomeマップのディスクキャッシュ**: `wthor_hash`(既存のrun identityで使っているハッシュ)+スキーマバージョンをキーに、集計済みoutcomeマップ・wthor_2024テスト集合をシリアライズしてキャッシュする(置き場所は `train/data/` 配下のgitignore領域)。キー不一致時は再構築。キャッシュ有無で結果がバイト一致すること。
3. **train_stepの重複計算排除**: (a) 親局面の `features()`/`predict()` の状態インデックス計算を1回に統合、(b) pairsループ内のbest側スコア/勾配をループ外へ引き上げ。数値結果(全エポックのmetrics、最終重み)が修正前とバイト一致すること。
4. (任意・時間が許せば) `canonicalize`/`transform_bits` のビットトリック化(64セルループ→シフト+マスク)。既存64セル実装との**全数または広範なランダム一致テスト**を付けること。リスクが高いと判断したら見送って作業ログに理由を書く。
5. 高速化の実測(修正前後の wall time)を作業ログに記録する。計測は**他の重い処理が走っていない専有状態**で行う(環境負荷混入の教訓)。

## やらないこと(スコープ外)

- エポック内のデータ並列化・mini-batch化(共有クラス重みとの競合で再現性リスク高、explorer調査の結論により不採用)
- 学習アルゴリズム・ハイパラ・損失・データ分割の変更
- engineクレートの変更(`pattern_eval.rs` 等は読み取り利用のみ)
- 200kコーパス対応・v3特徴対応(既存コードのまま動くはず。動かない場合のみ報告)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` / `cargo test -p engine` 全件パス(等価性テスト・キャッシュ整合テスト含む)
- [ ] 等価性: smokeコーパスで「修正前(現行main)」と「修正後(直列モード)」「修正後(並列モード)」の3通りを同一引数で実行し、選択重みのSHA-256が3者一致することを作業ログに記録
- [ ] キャッシュ: 初回(構築)と2回目(ヒット)で結果バイト一致、2回目の起動オーバーヘッドが大幅短縮していること
- [ ] 高速化実測: 6run(primaryコーパス、実エポック)で修正前比の合計wall time短縮率を記録
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 不変(engine無変更の確認)
- [ ] 変更対象ファイルのみパス指定でコミット(Codexサンドボックスではコミット不可のため、変更ファイル一覧を完了レポートに明記しオーケストレーターが代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-15 16:05 JST — Codex実装

- 実施内容: `train/src/t090_distillation.rs` に、論理コア数とrun数の小さい方を既定並列度とする scoped thread 実行を追加した。`--jobs N` で上限を指定でき、`--jobs 1` は従来順序の直列実行となる。run identity・run別checkpoint directory・epoch単位checkpoint/resumeは変更していない。
- WTHORキャッシュ: 従来と同一の `wthor_hash` とスキーマversion 1をキーに、outcome mapとcanonical順のWTHOR 2024 test集合を固定little-endian形式で `train/data/t090-wthor-outcomes-v1-<hash>.bin` に保存するようにした。ヘッダmagic/schema/hash、重複key、enum値、truncation/trailing bytesを検証し、不正・不一致なら再構築する。キャッシュファイルは既存の `train/data/` gitignore規則に一致。
- 重複計算排除: 親局面のpattern state indexから予測値と勾配を共用し、rankingのbest子局面はscoreとgradient用featuresをpairs loop外で1回だけ計算するよう変更した。勾配加算順序は維持した。
- 等価性テスト: キャッシュのbit-preserving roundtrip・wrong-key・truncationテストと、旧 `train_step` 計算をテスト内に保持して10 stepすべてのloss bitおよびweight bytesを比較するテストを追加した。
- smoke等価性（同一引数、1 epoch、6run）: 修正前、修正後 `--jobs 1`、修正後既定並列（jobs=6）で各runの `final.bin` SHA-256が3者一致。`teacher-only-seed-1=103AEE6E72FBF707DF42975776686E46ABE324EABABC250D07637AB0448F4169`、`teacher-only-seed-2=49D560A0A8D40F630DBE3F2755BCA946D4ACC07733FB2C8F7E01229B2C52F0E2`、`baseline-seed-1=A9F60406C7BB532C29983F5363BEA34B48C6FB8B35872B16B96F2391D450C62A`、`baseline-seed-2=F3750D28BB3FCB888FFB47778FA68A90FB1D0534CF759AF84067200552382B18`、`no-ranking-seed-1=33DD34E8D5C00ADF764AA2F339E8B312F28BB7DA01D7F9E64856E966479E0711`、`no-ranking-seed-2=0F2DF888C054D319981AEC0E16ED52E20DEC7AA627138B73EBC99DF442DF0DB2`。
- キャッシュ実測（release smoke 6run、1 epoch、専有状態）: 初回構築+直列22.508秒、2回目cache hit+直列0.692秒（同一6runの重みは全件byte一致、wall 96.9%短縮）。cache hit+並列は0.421秒。修正前の同一smoke直列は18.792秒。
- primary高速化実測（release、50,000 corpus、6run、最大60 epoch/early stopping、専有状態）: 修正前直列96.989秒、修正後cache hit+既定jobs=6で37.480秒、61.4%短縮。6runすべてについて修正前後の `best.bin`・`final.bin`・`metrics.tsv` のSHA-256一致を確認した。
- 実行コマンドと結果: `cargo check -p train` 成功。`cargo test -p train` は38 passed。`cargo test -p engine` は178 passed / 既定ignored 2。`cargo test -p engine --release --test ffo_bench -- --nocapture` はFFO #40〜#44の5局面が期待score一致（1 passed / heavy 1 ignored、513.32秒）。release trainerのsmoke/primary比較実行はいずれもexit 0。
- 任意項目4は見送り: 必須3項で61.4%短縮を達成しており、canonicalizeのbit trick化は広範な一致検証を要する追加リスクのため、数値不変を優先して今回は変更しなかった。
- 一時成果物: `train/data/t095/` の比較checkpointはSHA確認後に削除。実運用キャッシュのみgitignore領域に保持。コミットはサンドボックス制約により未実施（オーケストレーター代行予定）。

### 2026-07-15 — verifier検証(独立再実行)

判定: **合格**。コミット6aedde8(`train/src/t090_distillation.rs`のみ変更)を対象に、コード修正なしで受け入れ基準を1つずつ独立実行した。

- `cargo test -p train`: 38 passed / 0 failed(`optimized_train_step_is_bit_identical_to_legacy_calculation`・`outcome_cache_round_trips_and_rejects_wrong_key`含む)。
- `cargo test -p engine`: 178 passed / 0 failed / 2 ignored(既知のFFO fast/heavy ignore、engine無変更につき想定どおり)。
- smoke等価性(`--corpus train/data/teacher/corpus_smoke.jsonl --max-epochs 1 --reference-weights train/weights/pattern_v2.bin`、checkpoint-dirはscratchpad配下): `--jobs 1`(直列)と既定(`distillation_jobs=6`、並列)を実行し、6run全てのfinal.bin SHA-256が一致。値もCodex作業ログ記載の6ハッシュ(`baseline-seed-1=a9f60406...`ほか)と完全一致した。「修正前」との3者比較は本再検証(直列/並列)とCodex作業ログ記載値の照合により確認(git checkoutでの旧コード再実行は実施せず、指示どおり省略)。
- キャッシュ検証: `train/data/t090-wthor-outcomes-v1-b6e39360424d3b91.bin`を一旦`.bak`にリネームして初回実行(cache miss)→20.192秒でcache_built、2回目実行(cache hit)→0.663秒でcache_hit(96.7%短縮、Codex報告の96.9%短縮と整合)。両実行の6run final.bin SHA-256は完全一致。再構築されたキャッシュファイルは元の`.bak`とSHA-256完全一致(内容同一)を確認後、`.bak`を削除して元のキャッシュファイルのみ残した。
- primary高速化実測(release、既定`--max-epochs 60`・early stopping、専有状態は保証せず概略確認): 直列(`--jobs 1`)70.281秒 → 既定並列(`distillation_jobs=6`)33.964秒、**51.7%短縮**(Codex報告の61.4%より低いが、環境負荷混入の可能性があり指示どおり概略確認扱い。並列が直列より明確に速いことは確認できた)。6run全てのfinal.bin SHA-256は直列・並列で完全一致(early stopping込みでも決定性維持を確認)。
- `cargo test -p engine --release --test ffo_bench -- --nocapture`: #40〜#44 全問 score=expected 一致(1 passed / 1 ignored(heavy)、563.52秒)。
- コミット範囲確認: `git show --stat 6aedde8` で変更ファイルが`train/src/t090_distillation.rs`のみであることを確認。
- `git status --short`: 検証セッション終了時点で出力なし(残骸なし)。scratchpad配下の一時checkpoint・キャッシュ`.bak`は検証後にクリーンアップ済み(キャッシュ本体はgitignore領域に正常に残置)。

以上により受け入れ基準7項目すべてパス。
