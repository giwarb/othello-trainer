---
id: T159b
title: 早期打ち切りの--simple-corpus(Egaroucid)経路対応 — Egaroucid全量学習シリーズ(1.5/3)
status: todo
assignee: implementer
attempts: 0
---

# T159b: 早期打ち切りのsimple-corpus経路対応

## 目的

T159で本番トレーナー(train_patterns_v3)に導入した早期打ち切りは、WTHOR経路専用で `--simple-corpus`(Egaroucidデータの取り込み経路、T155導入)とは併用エラーになる。**T160=Egaroucid全量25,514,097局面の学習は--simple-corpus経路で行うため、この経路への拡張が必須**(T159仕様の穴、オーケストレーター起因)。

あわせて、T159の代替レビュー(tasks/review/T159-trainer-early-stopping-claude-review.md)の中指摘3件を、25.5M規模で問題になる前にここで対処する。

## 変更対象

- `train/src/bin/train_patterns_v3.rs`(T159実装: 8372aa2)
- `train/src/simple_corpus.rs`(読み込み側の構造確認。必要最小限の変更のみ可)

## 要件

1. **検証splitの単位の調査と決定(最初にやる)**: `train/src/simple_corpus.rs` とEgaroucid実データ(`train/data/egaroucid/` 配下、gitignore領域)の形式を調査し、対局(game)境界が復元できるか確認する。
   - 対局境界が使える場合: WTHOR経路と同じく対局単位のハッシュsplitにする
   - 使えない場合: 局面ハッシュ単位のsplitとし、**類似局面リーク(同一対局由来・transposition)により検証MAEが楽観側に偏るリスクをレポートに明記**する(早期打ち切りの停止タイミングが遅れる方向のバイアスであり、致命的ではないが記録必須)
   - どちらを採用したかと根拠を作業ログ・完了レポートに明記
2. **メモリ効率(レビュー中3)**: 検証splitはT159のclone+flatten方式(ピーク約3倍メモリ)を避け、**インデックスベースの分割**にする(25.5M局面で確実に問題になるため)。WTHOR経路の既存実装は変更しなくてよい(T160はsimple-corpus経路のみ使う)が、共通化できるなら可。
3. **エポック評価コスト(レビュー中2)**: simple-corpus経路の早期打ち切りでは、毎エポックのフルパス評価をval_maeの1回に抑える(train損失は学習パス中の逐次集計で代替し、追加フルパスを行わない)。25.5Mでのエポックあたり追加コストの実測値(180k相当スモークからの外挿でよい)を作業ログに記録。
4. **resume脆弱窓の解消(レビュー中1)**: checkpoint保存後・state.txt書き込み前にクラッシュすると「checkpoint epoch mismatch」で恒久再開不能になる問題を、simple-corpus経路では起こさない(書き込み順序の見直しまたは片側先行を許容する回復ロジック)。WTHOR経路側も同一修正が安全に共有できるなら直してよい(OFF経路の不変は維持)。
5. **identity/決定性**: simple-corpus早期打ち切り用のidentity(corpus識別・フラグ群を含む)。同一入力での再実行・resumeが決定的に同一結果になること。
6. **軽微修正(レビュー指摘のうち安価なもの)**: `append_result_earlystop` の重複判定キーのプレフィックス衝突(seed 1 vs 12)を修正。`--epochs`がON時に黙って無視される点は明示エラーまたは警告にする。
7. **テスト**: (a)simple-corpus経路のOFF時不変(既存T155スモーク方式) (b)split決定性 (c)resume同一性(脆弱窓ケース=checkpointのみ先行した状態からの回復を含む) (d)patience/ベスト復元(小さな合成corpusで)。
8. **動作確認**: Egaroucid実データの小サブセット(例: 180k局面相当)で `--simple-corpus --early-stop` 学習を1回実行し、エポック推移・打ち切り・所要時間を記録(成果物はtrain/data/配下gitignore領域)。**この実測から25.5M全量の1エポック時間と総時間の見積りを算出し作業ログに明記**(T160の仕様に使う)。

## スコープ外

- Egaroucid全量25.5Mでの学習実行(T160)
- B3特徴側の変更・対局ゲート・採否判定
- WTHOR経路のメモリ/コスト最適化(共有修正が自然な場合を除く)

## 受け入れ基準

1. `cargo test -p train` 全パス(新規テスト込み)
2. simple-corpus経路のOFF時不変(重みSHA-256一致)とWTHOR経路(early-stop ON/OFF両方)の挙動不変の実証が作業ログにある(WTHOR ONはT159の180kスモーク再現等の軽い方式でよい)
3. Egaroucid実データのサブセットで早期打ち切りが動作した記録と、25.5M全量の時間見積りがある
4. 変更ファイル一覧と検証結果を完了報告に明記。パス明示でadd・コミット(`git add .`/`-A`禁止)。一時ファイル不残置、完了時 `git status --short` クリーン(`tasks/`とCLAUDE.mdはコミットしない)

## コミット規律

- `tasks/` と `CLAUDE.md` は変更しない(作業ログ追記は行う)。学習スモーク中は他の重い処理と並行しない。detached起動+ツール呼び出しポーリング(Bashバックグラウンド・Monitor通知依存禁止)

## 作業ログ

### 2026-07-21 着手・調査(要件1: 検証splitの単位決定)

- `train/src/simple_corpus.rs`(既存T155実装)を精読: 簡易レコードは1行=`<64文字盤面> <スコア>`のみで、対局ID・手順連番・タイムスタンプ等の一切のメタデータを持たない。
- `train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17/`(26ファイル、各ファイル1,000,000行、合計約1.7GB)を実際に調査:
  - `README_EN.md`(配布元ドキュメント)に明記されている形式も「1 million pairs of board and score」のみで、対局・セッションの概念自体が存在しない。
  - 実データの隣接行を確認したところ空きマス数(手数の目安)がバラバラ(例: 30, 30, 50, 34, ...)で、対局の一連の手として連続している形跡もない(生成時点で既にシャッフル済みと判断)。
- **結論: 対局境界は復元不可能。局面(position)単位のハッシュ分割を採用**(要件1で規定されたフォールバック方針どおり)。`train/src/simple_corpus.rs`に`split_for_early_stop`を新規追加(既存`split_by_position_hash`は無変更)。frozen判定は`split_by_position_hash`と全く同じ式(`fnv1a(canonicalKey)%10==9`)を再利用し、frozen以外から別salt付きハッシュで検証splitを切り出す(frozenとの相関を避けるため)。D4対称の完全重複はcanonicalKeyで確実に同じ側に入る(テスト`split_for_early_stop_keeps_symmetric_duplicates_in_the_same_bucket`で確認)。
- **既知のリスク(致命的ではないが記録)**: 対局概念が無い以上、同一対局(または類似局面)由来のサンプルがtrain/valに跨って入りうる可能性は分割方式では検出できない。これは検証MAEを楽観側に歪め、早期打ち切りの停止判定を遅らせる方向のバイアスであり、致命的ではないがT160実行時に留意すること(コード内コメントにも明記)。

### 実装(要件2〜6)

- **要件2(メモリ、レビュー中3)**: `split_for_early_stop`はpoolの所有権を受け取り、1回の消費ループでtrain/val/frozenの3つのVecへ振り分ける(cloneなし)。WTHOR経路の`split_early_stop_validation`(対局Vecをclone+flattenしてピーク約3倍メモリになる、T159実装のまま無変更)とは異なり、25.5M局面規模でも追加メモリはほぼ発生しない。
- **要件3(エポック評価コスト、レビュー中2)**: `train/src/regression.rs`に`Model::train_epoch_with_running_loss`を追加(既存`train`/`train_epochs`/`sgd_step`は無変更・追加のみ)。1エポック分のSGD学習と同じシャッフル順序で処理しながら、各サンプルの「更新前予測」による二乗誤差・絶対誤差を集計して返す(オンラインSGDの一般的な「学習中損失」)。新設の`run_config_seed_early_stop_simple`(simple-corpus専用、WTHOR経路の`run_config_seed_early_stop`は無変更)はこれを使い、毎エポックのフルパス評価を`val_mae`(`mean_absolute_error(val_samples)`)の1回だけに抑えた(WTHOR経路は従来どおり train_mse/train_mae/val_mae の3フルパスのまま、要件のスコープ外)。
- **要件4(resume脆弱窓、レビュー中1)**: `metrics.tsv`のヘッダに`best_epoch`/`best_val_mae`列を追加(`EARLY_STOP_METRICS_HEADER`)し、各行が単独で`EarlyStopState`を再構成できる自己完結した記録にした。新設`recover_early_stop_state`が、checkpoint保存後・state.txt書き込み前のクラッシュ(state.epoch = checkpoint_epoch - 1)や、state.txt自体が無い(さらに早いクラッシュ)場合に、対応するmetrics行から状態を再構成してstate.txtを自己修復する。2エポック以上のズレなど復旧不能な破損は従来どおり明示エラー(手動復旧手順を含む)で停止する。WTHOR経路の`run_config_seed_early_stop`もこの共有ヘルパーを使うよう更新した(レビューが「安全に共有できるなら直してよい」としていたため。OFF経路は無変更)。
- **要件5(identity/決定性)**: simple-corpus早期打ち切り用に新schema`schema=6-earlystop-simple`(corpus_hash・reservoir_seed・simple_max_records・early-stop全パラメータ・train/val/frozenサンプル数を含む)を追加。reservoir sampling後のpool分割なので、決定性はpoolの決定性(corpus_hash+reservoir_seed+max_records)に載ることをidentityに反映した。
- **要件6(軽微修正)**: `append_result_earlystop`の重複判定キーを`starts_with(&key)`から`starts_with(&format!("{key}\t"))`に修正(seed 1 vs 12のプレフィックス衝突を解消。`append_result`(OFF経路)は変更していない)。`--early-stop`指定時に`--epochs`が同時指定されていたら警告を出す(`--max-epochs`を使うべき旨)よう`main`に追加。

### テスト(要件7、cargo test -p train)

- `train/src/simple_corpus.rs`: `split_for_early_stop`の決定性・網羅性・`split_by_position_hash`とのfrozen一致・D4対称重複の同居を確認する4件を追加。
- `train/src/regression.rs`: `train_epoch_with_running_loss`が`train_epochs`と重み更新面でビット同一であること、および誤差が学習の進行とともに縮小することを確認する2件を追加。
- `train/src/bin/train_patterns_v3.rs`: 以下7件を追加(既存9件は全てそのままパス):
  - `simple_corpus_off_path_matches_direct_model_training_bit_for_bit`(7a)
  - `recover_early_stop_state_heals_checkpoint_ahead_of_state_window` / `_heals_missing_state_file` / `_rejects_unrecoverable_gap`(4・7c基礎)
  - `early_stop_resume_recovers_from_checkpoint_ahead_of_state_window`(7c、WTHOR経路共有ヘルパー経由の統合テスト)
  - `simple_corpus_early_stop_restores_best_checkpoint_and_stops_before_max_epochs`(7d)
  - `simple_corpus_early_stop_end_to_end_splits_and_trains`(CLI相当のエントリポイント`run_early_stop_simple_corpus`の疎通確認)
- 結果: `cargo test -p train`(全バイナリ、計137件)全パス。`cargo test -p engine`(216件、2 ignore、本タスクでengineは無変更)全パス。

### OFF時不変の実証(要件2の受け入れ基準)

`git stash`でT159b差分(train_patterns_v3.rs/regression.rs/simple_corpus.rs)を退避しHEAD(T159時点)のバイナリをビルド→小規模スモークを実行→SHA-256記録→`git stash pop`で復元・再ビルド→同じコマンドを再実行して比較。

- **WTHOR OFF**(`--configs v3 --seeds 1 --epochs 2 --max-games 30`): 前後とも`5228350a01ded3cdb27093bfc0c8c78b70d63251827f94412b8c7748e4c2d687`(T159時点の記録値とも一致)。
- **simple-corpus OFF**(Egaroucid実データ先頭2000行を切り出し、`--configs v3 --seeds 1 --epochs 2 --simple-corpus <2000行ファイル>`): 前後とも`f7508ab5e197a49a907c24e25dd070c18e56e9b39bb797b4a5a74552dee7d790`。
- **WTHOR ON**(`--early-stop`、小規模: `--max-games 60 --early-stop-val-percent 10 --early-stop-patience 2 --max-epochs 8`)を実行し、新しい`metrics.tsv`(8列)・`recover_early_stop_state`共有経路込みでCLIから正常完走することを確認(best_epoch=3, epochs_run=5, 最終binとbest.binのSHA-256一致)。

### 要件8: Egaroucid実データでの動作確認・25.5M全量の時間見積り

**180kスモーク**(実データ、PowerShell Start-Process detached + ツール呼び出しポーリング、Bash run_in_background/Monitor通知待ちのみへの依存はしない):
- コマンド: `--configs v4 --seeds 1 --simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --simple-max-records 180000 --early-stop --early-stop-val-percent 5 --early-stop-patience 3 --max-epochs 30 --output-dir <一時dir>`
- データセット: `total_lines=25514097 pool_size=180000(reservoir sampling) train_samples=149849 val_samples=7800 frozen_samples=22351`
- 結果: val_maeが25エポックかけて10.21→8.43まで単調気味に改善しつつ非単調な揺り戻し(悪化)を挟み、`best_epoch=22`でpatience=3が発火して`epoch=25`(30エポック未満)で打ち切り。`frozen_mse=123.300150 frozen_mae=8.206586`。simple-corpus専用の1パス評価(`train_epoch_with_running_loss`)がCLIから正しく機能することを確認。
- 所要時間: 実測約14.8秒(release build、25エポック分・訓練149,849件+検証7,800件)。

**25.5M全量の1エポック実測**(見積りの精度を上げるため、実データ全量・`--simple-max-records`無指定(全件保持)・`--max-epochs 1 --early-stop-patience 1`で実際に1エポックだけ学習する測定を追加実行。T160本番の複数エポック学習そのものはスコープ外のため実行していない):
- コマンド: `--configs v4 --seeds 1 --simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --early-stop --early-stop-val-percent 5 --early-stop-patience 1 --max-epochs 1 --output-dir <一時dir>`
- データセット: `total_lines=25514097 pool_size=25514097(全件) train_samples=21210114 val_samples=1114591 frozen_samples=3189392`
- 実測: プロセス開始05:33:32.72 → 結果出力(ファイル最終更新)05:35:36.08、**総所要時間123.36秒**(全量25.5M行の読込・パース・split_for_early_stopによる3分割・1エポック分のSGD学習(21.21M件)・検証評価(1.11M件)・frozen評価(3.19M件)・成果物書き出しを全て含む)。ピークメモリ(Working Set)は約0.8〜1.2GB。
- 参考: 25.5M行を読み飛ばし主体で走査するだけの測定(`--simple-max-records 10`、ほぼパースなし)は4.3秒(=純粋な全行スキャン+ハッシュのコスト下限)。

**25.5M全量の時間見積り(180kスモークとの比率・全量1エポック実測の両方から算出)**:
- 180kスモークの実測(train+val合計157,649件・25エポック・14.8秒)から、エポックあたりコスト ≈ (14.8−4.3)/25 ≈ **0.42秒/エポック(157,649件あたり)**。
- 全量(train+val合計22,324,705件)はこの**141.6倍**の規模 → 比率から1エポックあたり ≈ 0.42×141.6 ≈ **59.5秒/エポック**と推定。
- 全量1エポック実測(123.36秒)からこの推定エポックコストを差し引くと、**読込・パース・split・frozen評価を含む固定オーバーヘッドは約64秒**(1回のプロセス起動につき1回だけ発生し、config×seedの複数回ループでも`main`内でpool読込は1回のみ=以後のconfig/seedループでは再発生しない)。
- **25.5M全量・`--max-epochs 30 --early-stop-patience 3`(典型ケース)の想定総時間(1 config×1 seedあたり)**:

  | 打ち切りエポック | 想定総時間 |
  |---|---|
  | 10エポックで打ち切り | 約11分 |
  | 15エポックで打ち切り | 約16分 |
  | 20エポックで打ち切り | 約21分 |
  | 25エポックで打ち切り(180kスモークと同程度) | 約26分 |
  | 30エポック(patience未発火・上限まで) | 約31分 |

  → **1 config × 1 seedあたり概ね15〜30分程度**を見込む(180kスモークではpatience=3がepoch25で発火しており、全量でも同程度〜やや遅い打ち切りが起きる可能性がある。データ量が増えるとSGDの1エポックあたりの実効更新回数が増え収束が速まる可能性もあり、実際の打ち切りエポックはこの範囲内で変動しうる)。
- **複数seed/複数configをまとめて1プロセス起動で回す場合**(`--configs`/`--seeds`にカンマ区切りで複数指定): データ読込(約64秒)は起動1回につき1回だけで、以降の(config, seed)の組ごとに上表のエポックコストが積み上がる(例: v4を3 seedで回すなら、64秒 + 3×(15〜30分) ≈ 46〜91分)。

**T160向けの重要な申し送り(B3設定のブロッカー)**: `main`の既存ガード(T155由来、本タスクでは変更していない)が「`configs.iter().any(|config| config.t158)`なら`--simple-corpus`を拒否」としているため、**B3特徴(`t158-b3`)設定は現状`--simple-corpus`と一切併用できない**(`--early-stop`の有無に関わらず)。T159bのスコープ外(「B3特徴側の変更」は対象外と明記)のため本タスクでは対処していないが、**T160の計画「素のv4構成+B3特徴あり構成の両方をEgaroucid全量で学習」はこのガードにより素のv4構成しか実行できない状態**。B3をEgaroucidデータで学習するには、別途このガード(および対応するfeature-distribution出力等)を見直す小タスクが必要になる。

### 2026-07-21 verifier検証

対象コミット: fa448f0(train/src/bin/train_patterns_v3.rs、train/src/regression.rs、train/src/simple_corpus.rs)。作業ツリーはfa448f0 + tasks:のみのコミット(b424f78)、コード差分はfa448f0時点のまま。

1. `cargo test -p train --release`: 全11バイナリ/テスト群を合計 **137 passed; 0 failed**(96+4+3+2+0+0+0+16+10+5+1=137、内訳は`train_patterns_v3`16件・`wthor_lines`10件・`wthor_to_simple`5件・`real_data`1件・lib側96+4+3+2件)。実装者申告の137件と一致。参考: `cargo test -p engine`は本タスクスコープ外のため未再実行(前回タスクで確認済み、engine側ファイル変更なし)。
2. **OFF時不変の独立追試**: `git worktree add <scratchpad>/before fa448f0~1`(=f7523cc、コード差分としてはT159時点相当)で変更前ツリーをreleaseビルドし、変更後(現HEAD)のreleaseビルドと比較。
   - WTHOR OFF(`--configs v3 --seeds 1 --epochs 2 --max-games 30`): 前後とも標準出力(`dataset games=30 ... frozen_mse=820.721583 frozen_mae=25.634342 bytes=5964708`)が完全一致し、`v3-seed-1.bin`のSHA-256は前後とも `5228350a01ded3cdb27093bfc0c8c78b70d63251827f94412b8c7748e4c2d687` で実装者申告値と一致。
   - simple-corpus OFF(`train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17/0000000.txt`の先頭2000行を切り出し、`--configs v3 --seeds 1 --epochs 2 --simple-corpus <2000行ファイル>`): 前後とも標準出力(`corpus_hash=ad398f0d69ea0596 ... frozen_mse=455.377495 frozen_mae=16.971660`)が一致し、`v3-seed-1.bin`のSHA-256は前後とも `f7508ab5e197a49a907c24e25dd070c18e56e9b39bb797b4a5a74552dee7d790` で実装者申告値と一致。
   - 検証後 `git worktree remove --force` でworktreeを除去し、生成物・切り出しファイルはscratchpad配下ごと削除。
3. 時間見積りの記録確認: 作業ログに180kスモーク(実測約14.8秒、val_mae 10.21→8.43、best_epoch=22でpatience発火、epoch=25打ち切り)、25.5M全量1エポック実測(総所要時間123.36秒、内訳・ピークメモリ約0.8〜1.2GB)、エポックあたりコスト推定(≈59.5秒/エポック)・固定オーバーヘッド推定(約64秒)、および10/15/20/25/30エポック打ち切り時の想定総時間表(約11分〜約31分)・複数seed/config時の合算例が記載されていることを確認(再実行はしていない)。
4. B3併用ガード: `./target/release/train_patterns_v3.exe --configs t158-b3 --seeds 1 --epochs 2 --simple-corpus <2000行ファイル>` を実行し、`T158 configs require the WTHOR game split` を出力して終了コード1で拒否されることを確認(T160の既知ブロッカーとして作業ログの記載と一致)。
5. リポジトリ清潔性: `git status --short` は完全にクリーン(差分・未追跡ファイルなし)。`train/data/`配下は`.gitignore`(`train/data/`)で全体除外済みのためgit管理上の残置懸念はなく、`train/data`内にt159b固有の残骸ディレクトリ(`*t159b*`等)は見当たらない(既存の他タスク由来ディレクトリ`t087`/`t126`/`t127d`/`t144`/`t153`/`egaroucid`のみで、いずれも本タスク以前からのもの)。検証で使った切り出しファイル・worktree・出力はすべてscratchpadに作成し、検証終了時に削除済み。
6. コード修正: 行っていない(Read/Bash/git worktreeによる検証のみ)。

**総合判定: 合格**。5項目の受け入れ基準すべてを満たすことを独立に確認した。気づいた問題点: なし(申し送りのB3併用ガード制約はT159bのスコープ外として明記済みで、T160側課題として妥当に記録されている)。
