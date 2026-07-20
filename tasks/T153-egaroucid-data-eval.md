---
id: T153
title: Egaroucid公開学習データの取得・変換・同量対照の品質確認(軽ステップ)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T153: Egaroucid学習データの品質確認

## 目的(ユーザー指示 2026-07-20「学習データを集める方向も検討に入れて」)

Egaroucid公式の公開学習データ(局面+lv.17評価値、約2,551万局面)を取得・変換し、**同量対照でWTHOR/蒸留系の既知基準と比較**して教師としての品質を確認する。良好ならフル学習(重い、別タスク)へ進む判断材料になる。調査の正: `tasks/design/public-training-data-2026-07-20.md`。

## 要件

1. **取得**: https://www.egaroucid.nyanyan.dev/ja/technology/train-data/ から Egaroucid_Train_Data.zip をダウンロードし、`train/data/egaroucid/`(gitignore領域)に展開。アーカイブと展開物のSHA-256・サイズ・件数を記録。**リポジトリにデータをコミットしない(再配布禁止)**。gitignoreの追記が必要なら行う(train/data/は既にignore済みのはず、確認のみ)。
2. **形式確認と変換**: 形式は「64文字盤面(X=手番石、O=相手石、-=空き、a1→h8順)+スペース+スコア(手番側の予想最終石差、lv.17)」。件数・スコア分布・石数分布を集計してレポート。トレーナー入力への変換: `train/src/t090_distillation.rs` に**単純(盤面,スコア)корpusの入力モード**(例: `--simple-corpus <jsonl or txt>`)を追加する(teacher-only損失で位置→スコアを直接学習。既存の蒸留コーパス経路・既定挙動は完全不変にすること。ユニットテスト付き)。変換スクリプトまたはRust側での直接読込のどちらでもよい(決定的であること)。
3. **同量対照の品質確認**(軽い学習のみ、各run数分想定):
   - v4パターンセット・teacher-only・--jobs 1・seed 1で、**Egaroucidデータの層化サブセット@約90万件**(T127dの実train 899,467に規模を合わせる)を学習し、T096 oracle 60局面で評価(**M2ガード必須**: v2=1.5666666666666667の完全再現を記録)。
   - 参考としてサブセット@180k(T126系の点と同規模)も1本。
   - 比較基準(再計測不要、既知値): v4×蒸留1M=1.900 / v4×蒸留180k(K=1系)=2.767 / v2×WTHOR=1.5667 / v4×WTHOR(443万)=1.111。
4. **レポート**: bench/edax-compare/ に t153_egaroucid_data_report.md(+meta json)として、データ諸元・変換方法・学習結果・基準との比較・「フル2,551万学習に進む価値があるか」の客観所見を記録しコミット。
5. 長時間実行ルール: ダウンロード(数百MB級か、サイズは実測)とサブセット学習はcheckpoint/進捗ログの既存機構を踏襲。フル学習はしない。

## スコープ外(重い処理=後回し、ユーザー方針)

- フル2,551万件での学習・対局ゲート・本番採用判断(T153の結果を見てユーザー/オーケストレーターが判断)
- v0002棋譜5,200万局のリプレイ増強・WTHOR最新版統合(別タスク候補)
- app/engine変更(Pages確認不要)

## 受け入れ基準

1. データ取得記録(URL・SHA-256・サイズ・件数)と分布サマリがレポートにある
2. トレーナーの新入力モードが既定挙動不変(既存テスト+新テストで担保)、`cargo test -p train` 全パス
3. 同量対照(@90万・@180k)のoracle結果がM2ガード記録付きでレポートにあり、既知基準との比較表がある
4. 変更ファイル(コード・レポートのみ)はパス明示でコミットしmainへpush、**データファイル非コミット**、完了時 `git status --short` クリーン
5. タスク完了時点で当該タスク由来の未追跡がリポジトリに残っていない(データはgitignore領域のみ)

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

(ワーカーが節目ごとに追記)

### 2026-07-20 着手・データ取得・トレーナー実装・テスト完了

- **取得**: `https://github.com/Nyanyan/Egaroucid/releases/download/training_data/Egaroucid_Train_Data.zip` を `train/data/egaroucid/Egaroucid_Train_Data.zip` へダウンロード(401,502,981 bytes、SHA-256=`2c2da46c343b167d2a1dfa004881ce2b792425355aeb9378b93d03fa41dcbbd5`)。`train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17/` に展開(26個のtxtファイル、合計1.7GB)。全26ファイルの行数合計を`wc -l`で実測し、READMEの公称値と完全一致(25,514,097)を確認。各txtファイルのSHA-256はscratchpadに記録済み(レポートにも転記予定)。ライセンス確認: README_JA.md記載「自由利用可・再配布禁止・出典明記推奨・無保証」(design report記載どおり)。`.gitignore`の`train/data/`が既にegaroucidディレクトリをカバーしていることを確認(追記不要)。
- **形式確認**: 1行=`<64文字盤面(a1..h8順、X=手番石/O=相手石/-=空き)> <手番側予想最終石差>`。README記載の石数別局面数表(4石=1〜13石=434,029、14〜63石=各500,000、合計25,514,097)を実データの合計行数と突き合わせて確認(表自体は設計として保証された値のため個別再集計はしていない)。スコア分布はawk一括集計: n=25,514,097, mean=1.0080, min=-64, max=64, stddev=22.0566。README記載の重要な注意点: 石数15以下(序盤11手まで)はlv17による網羅列挙+探索の教師値、石数16以上は自己対戦の終局結果(ランダム打ち区間除く)に基づくラベルであり、蒸留コーパスの「教師値」とは生成方法が異なる(レポートに明記)。
- **トレーナー実装(要件2)**: `train/src/t090_distillation.rs`に`--simple-corpus <file|dir>`モードを追加。`pub fn run()`冒頭で`arg("--simple-corpus")`をチェックし、指定時のみ完全に独立した`run_simple()`へ分岐(既存の`load_corpus`/`DistillRecord`/`run_one`/`run_all`経路には一切触れない)。新規型`SimpleRecord{key,board,teacher_value}`(mover固定Black、X=own規約はpattern_state_indexのown/opponent正規化により問題なし)。ストリーミング読込+Algorithm R(reservoir sampling、`--simple-max-records`で件数上限を指定可能、未指定なら全件)により2551万行でもメモリに乗る規模へ決定的に間引く(採否によらず全行の生バイトからFNVで内容ハッシュを計算しresume identityに使用)。`select_simple_subset`は既存`select_train_subset`と同一の層化入れ子サブサンプリングロジックを型だけ分離して再利用。`simple_run_one`はcheckpoint/resume基盤(`latest_checkpoint`/`ensure_metrics_header`/`truncate_metrics_after`/`atomic_write`)を無改修のまま呼び出す。metrics.tsvは既存ヘッダ(7列)をそのまま使い、rankingが存在しない分は`validation_ranking_mae`列に常に0.0を書く。
- **テスト**: 新規ユニットテスト18件追加(`parse_simple_record_*`4件、`list_simple_corpus_files_*`2件、`load_simple_corpus_*`4件、`select_simple_subset_*`3件、`simple_train_step_*`1件、`simple_run_one_*`2件、他)。`cargo test -p train`: **74 passed; 0 failed**(既存56件も無変更で全パス、実データWTHORダウンロードテスト含む)。実データ(展開済みEgaroucidディレクトリ)でのスモークテスト(`--simple-max-records 5000 --train-subset-size 2000 --max-epochs 2`)も成功、25,514,097行の実測値と一致。
- **900k run起動**: `target/release/train_distillation.exe --simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --checkpoint-dir train/data/t153/egaroucid-v4-900k --pattern-set v4 --seeds 1 --jobs 1 --max-epochs 60 --simple-max-records 2000000 --train-subset-size 899467`。プール2,000,000件(train-eligible約1.8M、target 899,467を確実に満たす余裕)、両run(900k/180kターゲット)で同一プール・同一subset-seed(既定42)を使うため入れ子部分集合になる設計。ログを`train/data/t153/logs/900k.stdout.log`へ出力しMonitorで監視中(epoch単位のcheckpoint/resumeは既存基盤を無改修で利用、長時間実行ルール準拠)。バックグラウンド実行中、進捗は本ログの追記で追う。
