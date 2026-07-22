---
id: T181
title: Egaroucid v0002(5200万局)の最終石差ラベル実験 — 取り込み+学習+ゲート
status: done # verifier全項目合格(ゲート統計・共通frozen・変換ラベルの独立リプレイ照合まで)、2026-07-22。結論: 仮説不支持=E1/E2とも対v6有意悪化(CI完全マイナス)→不採用。資産: v0002変換ツール・frozen_mae_eval(データソース間公平比較)・v0002データ25M(ローカル、将来の再探索ラベル付け候補)
assignee: implementer
attempts: 0
---

# T181: v0002最終石差ラベル実験

## 目的

ユーザー仮説(2026-07-22朝):「強いAI同士の対戦結果なら、最終石差ラベルも有望」。Egaroucid v0002(Egaroucid 7.8.0 lv11 vs Edax 4.5.5 lv11、5,200万局、2026-06公開、スコアなし棋譜)を最終石差ラベルで取り込み、現行本番v6(lv17探索値ラベル25.5Mで学習)を超えられるか実験する。再探索不要のためエンジン速度に依存せず即実行可能。

## データ取得(T179調査結果参照: tasks/T179-public-dataset-survey.md)

- URL: GitHub Nyanyan/Egaroucid releases tag `training_data_v0002`(Egaroucid_Train_Data_v0002_0.zip / _1.zip)
- 形式: f5d6形式の着手列、1万局/ファイル。**ランダム序盤8〜59手で散らした対局**(各ply数×100万局)
- **ライセンス: 再配布禁止** → train/data/egaroucid_v0002/(gitignore領域)に置き、コミット禁止。取得したzipのSHA-256をmetaに記録
- ダウンロードは事前にファイルサイズを確認し報告してから実行(数GB級の見込み)

## 変換仕様

1. **パーサ+再生**: f5d6着手列をbitboard再生(パス処理・終局判定は既存engineロジック流用)。不正棋譜はスキップしカウント記録。
2. **ラベル**: 各局面に「その対局の最終石差(手番視点)」。simple-corpus形式(`<64文字盤面> <スコア>`)で出力。
3. **ランダム序盤の除外(配布元推奨)**: 各対局のランダム着手部分(冒頭Nply、ファイル/対局メタから判別。判別方法を調査し記録)に該当する局面は学習対象から除外し、エンジン着手区間のみ採用。
4. **サンプリング**: 全採用局面は数十億級になるため、**決定的サンプリングで2構成分を出力**: (A)約25M局面(現行と同規模、対局横断で層化: 空きマス数帯が現行データと近い分布になるよう設計し、設計をmetaに記録) 。将来の増量用にサンプリング率はパラメータ化。
5. 決定性(同一入力→同一出力SHA)・シャード単位checkpoint/resume・進捗ログ(長時間実行ルール)。

## 学習と判定(事前登録)

6. 学習2構成×3seed(いずれもt158-b3(v6構成)・canonical・早期打ち切り、T165と同一フラグ):
   - **E1**: v0002石差ラベル25M単独
   - **E2**: 現行lv17 25.5M + v0002 25M の混合(単純連結。混合比の最適化はスコープ外)
7. **スクリーニング**: frozen評価は「現行Egaroucid(lv17)データの局面ハッシュfrozen split」で統一(3構成=現行v6学習時/E1/E2を同一frozenで比較可能に。E1/E2の学習にこのfrozen局面が混入しないよう除外処理を入れ、方式をmetaに記録)。seed選定=frozen MAE最小(構成ごと)。
8. **対局ゲート**: E1/E2の各ベストseedで vs Edax lv12 60局(T174基準線-6.07、現行v6も同条件で計測済み)。paired比較。**採用提案規準: 現行v6に対し有意改善(CI完全プラス)のみ**。
9. レポート: bench/edax-compare/t181_v0002_report.md + meta(変換統計・分布比較・学習表・ゲート結果)。

## スコープ外

- 本番配線(採用裁定後)・再探索ラベル付け(将来、エンジン高速化後の選択肢)・混合比チューニング

## 受け入れ基準

1. 変換の決定性・resume・不正棋譜処理・除外/サンプリング設計がレポートにあり、`cargo test`(触ったパッケージ)全パス
2. 2構成×3seedの学習表とfrozen比較(共通frozen設計の明記込み)がある
3. ゲート結果(paired統計、配列並び順明記)と規準当てはめがある
4. データ本体のコミットなし(gitignore確認)、完了時 `git status --short` クリーン(ツール・レポートはパス明示コミット)

## コミット規律

- **T180(ボトルネック分析)の専有計測と重い処理(変換・学習・対局)が重ならないよう調整**: 開始前・各重工程前にSTATUSのT180状態を確認し、T180が計測中なら待つ(タスクファイルの作業ログに調整記録)。detached+ツール呼び出しポーリング(Monitor依存禁止)。作業ログ節目追記

## 作業ログ

### 2026-07-22 調査・準備(implementer)

1. **T180調整確認**: `tasks/STATUS.md`でT180の状態を確認(STATUS上は`in_progress`表記だが、`tasks/T180-engine-bottleneck-analysis.md`のfrontmatterは`status: todo`・作業ログ空で未着手と判明)。`logs/`直下・`Get-Process`(cargo/rustc/eval_cli/python/wEdax)を確認したところ、現在実行中の関連プロセスは無し。**重い工程(変換・学習・対局)を開始しても現時点でT180の専有計測とは競合しない**と判断。今後、変換実行・学習開始・ゲート実行の各重工程の直前に再度確認する。
2. **v0002データの事前調査(ダウンロード前)**: `gh api repos/Nyanyan/Egaroucid/releases/tags/training_data_v0002`でファイルサイズを実測(ダウンロードはしていない):
   - `Egaroucid_Train_Data_v0002_0.zip`: 1,303,950,421バイト(約1.30GB、8〜33手ランダム打ち分)
   - `Egaroucid_Train_Data_v0002_1.zip`: 1,339,651,484バイト(約1.34GB、34〜59手ランダム打ち分)
   - 合計: 約2.64GB
   - リリースノート(英語・日本語併記)を取得し、ライセンス(再配布禁止、利用は自由)・形式を確認: フォルダ名が数値(8〜59)でランダム着手数を表し、各フォルダ内`XXXXXXX.txt`に1万局ずつf5d6形式で収録。**「ランダム序盤の判別方法」= フォルダ名の数値そのものが、その対局群の先頭ランダム着手数(除外すべきprefix長)を直接示す**(配布元推奨どおり、当該局面を学習対象から除外)。
3. **f5d6形式の確認**: Egaroucid公式ドキュメント(`docs/en/usage/index.html`)より、f5d6は2文字ずつの着手記譜(例: `f5d6c3d3c4`)の連結で、大小文字・空白は無視、パスは省略可または`PA`/`PS`(大小問わず)で表現可能と判明。
4. **既存資産の確認**: `train/src/train_data.rs`の`samples_from_game(moves: &[u8]) -> Result<Vec<Sample>, String>`が、**実際の着手インデックス列(パス除く)を再生し、パスは合法手なし側を自動スキップして判定、各局面に「手番視点の最終石差」ラベルを自動付与する**既存関数であることを確認。これはまさに本タスクが必要とするロジックそのもの(f5d6の2文字記法→マスインデックス変換のみ新規実装すればよく、再生・パス処理・最終石差ラベル付けは流用可能)。`train/src/bin/wthor_to_simple.rs`が同関数を使い`<64文字盤面> <スコア>`形式に変換する既存の変換ツール実装パターンとして直接の参考になる。`train/src/bin/egaroucid_filter_stones.rs`は既にsimple-corpus化済みのv0001データ用フィルタで、f5d6パース自体の参考にはならないが、決定的なファイル列挙・checkpoint規約の precedent として参考にする。
5. **ダウンロード承認・実行**: ユーザー承認(2026-07-22朝「ok」、コーディネーター経由で伝達)を受けて実行。
   - `Egaroucid_Train_Data_v0002_0.zip`(1,303,950,421バイト): SHA-256 `7123a56b647985b17f90b864e00ae5851cb015296315432965f4ad224ca7c87a`
   - `Egaroucid_Train_Data_v0002_1.zip`(1,339,651,484バイト): SHA-256 `9bbda568b8c3163c9d7e15c3d5a4b5d47693401d1b094928c1a8077b3538b73b`
   - 保存先`train/data/egaroucid_v0002/`(既存の`train/data/`gitignoreルールで自動的に除外を`git check-ignore`で確認済み)。
6. **実データの検証(展開・実物確認)**: 両zipを`train/data/egaroucid_v0002/extracted/{zip0,zip1}/`へ展開(展開後6.0GB、ディスク空き116GBのため問題なし)。実物確認の結果:
   - zip0のサブフォルダ`0002_egaroucid_7_8_0_edax_4_5_5_lv11_0`配下にランダム着手数フォルダ`8`〜`33`(各100ファイル)、zip1側は`0002_egaroucid_7_8_0_edax_4_5_5_lv11_1`配下に`34`〜`59`(各100ファイル)、想定どおり。
   - 各`.txt`は1万行、1行=1対局のf5d6文字列(区切りなし、2文字ずつの着手記譜連結)。folder="8"の1万局サンプルで行長は18〜120文字(9〜60手、対局によって早期終局あり)。
   - **パス記号("PA"/"PS"等)は4フォルダ(8/15/25/33)×3ファイルずつ=12万局サンプルで1件も出現せず** → 配布元はパスを明示せず、`samples_from_game`の自動パス判定(合法手なし側を自動スキップ)にそのまま委ねられる設計であることを確認(想定どおり、追加のパース処理不要)。
7. **frozen split機構の調査**: `train::simple_corpus::split_by_position_hash`/`split_for_early_stop`が、局面の**D4正規化canonicalKeyのFNV-1aハッシュ(`%10==9`→frozen)という、データソースに一切依存しない純粋関数**であることを確認(`train/src/simple_corpus.rs`)。これにより、E1(v0002単独)・E2(lv17+v0002混合)いずれも、`train_patterns_v3 --early-stop --simple-corpus`(T165と同一フラグ)を通すだけで、**同じハッシュ規則により「lv17のfrozenと同一の局面」は自動的にどちらの学習データからも除外される**(データソースに関係なく同じ盤面は常に同じtrain/frozen判定になるため、追加の除外コードは不要)。ただし「3構成を同一frozenで比較可能に」という比較用MAEの統一には、lv17のfrozen集合(具体的な局面インスタンス)を固定成果物として抽出し、v6・E1best・E2bestの全てをこの同一ファイルに対して評価する別建ての小ツールが必要と判断(次節参照)。
8. **既存トレーナーへの最小限拡張**: E2(lv17全量+v0002 25Mの単純連結)向けに、`train::simple_corpus::list_simple_corpus_files_multi()`(カンマ区切り複数パス対応)を新規追加し、`train_patterns_v3`の`--simple-corpus`引数パース箇所を差し替え(単一パス指定時は無変更)。ユニットテスト3件追加、`cargo test -p train --release`全パス(158 passed/0 failed)。コミット`d2fd124`。
9. **v0002変換ツールの実装**: `train/src/bin/egaroucid_v0002_convert.rs`を新規作成。設計: (a)f5d6の2文字記法→マスインデックス変換(パス記号は防御的にスキップ) (b)`train_data::samples_from_game`で再生・最終石差ラベル付け(既存関数を流用、新規実装なし) (c)フォルダ名Nを先頭除外手数として`samples[0..N)`を除外 (d)採用候補が数十億規模になるため、現行lv17コーパスの空きマス数分布を目標分布とし決定的ハッシュ層化サンプリング(`--target-count`既定2500万でパラメータ化)。ハッシュ判定はファイル相対パス・行番号・ステップ番号のみに依存する純粋関数のため、**採用が1件も無い対局は再生自体をスキップ**(52,000,000対局中、実際に再生するのは採用対象のごく一部で済み、大幅な高速化)。ファイル単位checkpoint(JSON、atomic rename)・resume・進捗ログを実装。ユニットテスト9件、`cargo build`警告0件、`cargo test`全パス。
10. **実機テストで2件の不具合を発見・修正**: (a)`BufWriter`が明示的flushと無関係に内部バッファ満杯時に自動でOSへ書き出すため、中断時点の出力ファイルの実バイト長がcheckpointの`samples_written`より先行してしまう不整合を発見(合成データでの中断テストで実際に再現: checkpoint記録690,012バイトに対し実ファイル820,520バイト)。`output_bytes_committed`をcheckpointに追加し、resume時に出力ファイルをその長さへ`set_len`で切り詰めてから追記を再開するよう修正。(b)`--in-dirs`をバックスラッシュ区切り(PowerShell)かスラッシュ区切り(Bash)かで指定すると、Windowsの`Path::join`が生成する内部パス文字列表現が変わり、採用判定ハッシュキーがずれて出力が変わってしまう不具合を発見(同一in_big合成データセットで49547/49605/49899と3通りの異なる結果を得て発覚)。`normalize_path_for_key`(`\`→`/`正規化)を追加して修正。修正後、PowerShell/Bash両方の呼び出し形式で出力SHA-256が完全一致(`ccd97d2d...`)し、中断→再開の実機テスト(合成32ファイル・32万局規模、実際に`Stop-Process -Force`で強制終了→resume)でも非中断実行と最終結果が完全一致することを確認。ユニットテスト3件追加(計12件)。コミット`a45b02c`。
11. **T180完了・T182開始の確認**: `tasks/STATUS.md`を再確認したところ、**T180は完了済み**(commit `59b5c41`、対Edax実測で終盤20倍・中盤57-69倍の速度差を確定)。**新規タスクT182(増分hash配線、T180優先度1位)が現在進行中**で、`engine/src/search.rs`への未コミット変更(import追加のみ、ビルド警告として検出)を実際に確認した。T182自身も「NPS計測はT181重工程と調整」と明記しており、相互調整が必要。T181の変換ツール(`train_data::samples_from_game`、`engine::bitboard`のみ使用)および学習(`train_patterns_v3`、`engine::pattern_eval`のみ使用)は`engine::search`に依存しないため、T182の作業と競合せず今すぐ実行可能と判断。**対Edaxゲート段階(`eval_cli`が`engine::search`に依存)の直前には、T182が完了・コミット済みであることを改めて確認する**(作業ログに追記予定)。
12. **v0002変換の本実行完了**: `train/data/t181/v0002_25m.txt`(gitignore領域)。**所要時間約700秒(約11.7分)**、52,000,000対局全件スキャン、不正棋譜0件、非合法手順0件、**24,919,545局面採用(目標2500万の99.68%)**。バケット別採用数はほぼ均一(空き1〜50は各約488,600〜491,249、空き51のみ424,603=対象供給不足)。中断→再開の実機テスト(合成データ)は10節記載のとおり別途完走。
13. **E1(v0002単独25M)学習開始**: T165のconfig C(`t158-b3`、canonical、早期打ち切り)と同一フラグで起動。
    ```
    target/release/train_patterns_v3.exe --configs t158-b3 --canonical --early-stop \
      --early-stop-patience 3 --max-epochs 30 --seeds <1|2|3> \
      --output-dir train/data/t181/e1-v0002 --simple-corpus train/data/t181/v0002_25m.txt
    ```
    seed1開始(05:51:26)。ログで`pool_size=24919545`(変換ツール出力と一致)・`train_samples=20736632`・`val_samples=1091174`・`frozen_samples=3091739`を確認。PowerShell `Start-Process`でdetached起動、ツール呼び出しポーリング(Monitor通知非依存)。
    - **seed1**: 完走(約16分、05:51:26〜06:07台)。best_epoch=12、epochs_run=15、frozen_mse=60.449053、**frozen_mae=5.842035**、bytes=27,986,840。stderr空。
    - **seed2**: 完走(06:09:11開始、約13分)。best_epoch=9、epochs_run=12、frozen_mse=60.582270、**frozen_mae=5.848404**。stderr空。
    - **seed3**: 06:22:22開始〜完走(約17分)。best_epoch=10、epochs_run=13、frozen_mse=60.526919、**frozen_mae=5.845760**、bytes=27,986,840。stderr空。
    - **E1完了・ベストseed選定**: seed1(5.842035) < seed3(5.845760) < seed2(5.848404)。**E1ベスト=seed1**(`train/data/t181/e1-v0002/t158-b3-canonical-seed-1-earlystop.bin`)。

14. **E2着手前のT180/T182調整確認**: `tasks/STATUS.md`を再確認。T180は完了済み(`59b5c41`)。**T182は`review保留`で、その作業ログに「NPS再計測はT181学習のCPU専有により延期(T181完了後の専有ウィンドウで計測)」と明記**されており、T182側がT181の専有終了を待つ関係(逆方向の競合ではない)。T182のコード変更(`engine/src/search.rs`のimport整理、挙動不変・verifier軽量検収済み)は`engine::search`内に留まり、E2学習(`train_patterns_v3`、`engine::pattern_eval`のみ使用)とは無関係。**競合なしと判断し、E2学習(seed1〜3)を続行**。

15. **E2(lv17+v0002混合)学習開始**: `--simple-corpus`にカンマ区切りで両パス指定(9節で追加した`list_simple_corpus_files_multi`を使用)。
    ```
    target/release/train_patterns_v3.exe --configs t158-b3 --canonical --early-stop \
      --early-stop-patience 3 --max-epochs 30 --seeds <1|2|3> \
      --output-dir train/data/t181/e2-mixed \
      --simple-corpus "train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17,train/data/t181/v0002_25m.txt"
    ```
    seed1開始(06:36:37)。ログで`total_lines=50433642`(lv17 25,514,097行+v0002 24,919,545行の合算と一致)・`pool_size=50433642`・`corpus_hash=c0b084c364a446db`・`train_samples=41946746`・`val_samples=2205765`・`frozen_samples=6281131`を確認。
    - **seed1**: 完走(約41分、06:36:37〜07:17台)。best_epoch=14、epochs_run=17、frozen_mse=49.694436、**frozen_mae=5.275110**(自ランのローカルfrozen split、lv17+v0002混合分)、bytes=27,986,840。stderr空。※このfrozen_maeはE1・v6と直接比較不可(自ランのfrozen集合がlv17のfrozen集合と異なるため)。共有lv17 frozen集合による横断比較は別建てツールで後続実施。
    - **seed2**: 完走(07:09:36開始、約38分)。best_epoch=10、epochs_run=13、frozen_mse=50.091302、**frozen_mae=5.297653**。stderr空。
    - **seed3**: 07:32:10開始〜完走(約38分)。best_epoch=9、epochs_run=12、frozen_mse=50.113914、**frozen_mae=5.298597**。stderr空。
    - **E2完了・ベストseed選定(自ランfrozen)**: seed1(5.275110) < seed2(5.297653) < seed3(5.298597)。**E2ベスト=seed1**(`train/data/t181/e2-mixed/t158-b3-canonical-seed-1-earlystop.bin`)。

16. **共有frozen比較ツールの新規実装**: `train/src/bin/frozen_mae_eval.rs`(新規、テスト3件込み)。トレーナー自身が報告する`frozen_mae`はE1(v0002由来のみ)・E2(lv17+v0002混合)でそれぞれ自分が読み込んだコーパスのfrozen split(局面ハッシュ%10==9)に対する値であり、v6(lv17単独)のfrozenとは異なる局面集合になるため直接比較できない。本ツールは`train::simple_corpus::split_by_position_hash`(データソース非依存の純粋関数、7節参照)を**lv17コーパス単独**に適用してfrozen集合を抽出・固定成果物として`train/data/t181/lv17_frozen.txt`(gitignore領域、simple-corpus形式)へキャッシュし、任意個の重みファイル(`train::regression::Model::from_bytes`、PWV1〜6自動判別)についてこの同一集合でMAE/MSEを算出する。`cargo test -p train --release --bin frozen_mae_eval`3件全パス、`cargo test -p train --release --lib`108件全パス(train_patterns_v3.exeがE2学習プロセスに保持され再ビルド不可のため`--bin train_patterns_v3`は別途学習完了後に確認)。
    ```
    target/release/frozen_mae_eval.exe --lv17-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 \
      --frozen-cache train/data/t181/lv17_frozen.txt --weights "label1=path1,label2=path2,..." \
      --out bench/edax-compare/t181_frozen_mae.tsv
    ```
    **実行結果**(lv17 frozen、samples=3,189,392、corpus_hash=8e14d3751185a95c):

    | label | frozen_mse | frozen_mae |
    |---|---|---|
    | v6(本番, lv17単独25.5M) | 35.923338 | **4.492196** |
    | e1-seed1 | 43.675037 | 4.968667 |
    | e1-seed2 | 43.798552 | 4.975879 |
    | e1-seed3 | 43.750656 | 4.973161 |
    | e2-seed1(lv17+v0002混合) | 40.409244 | 4.784592 |
    | e2-seed2 | 40.738452 | 4.806507 |
    | e2-seed3 | 40.758813 | 4.807344 |

    **同一lv17 frozenでの比較では、v6(本番)が最良、E2(混合)が次点、E1(v0002単独)が最劣**という結果。E1・E2いずれも**自ランのfrozen MAEによるseed選定(seed1が両構成とも最良)と、この共有lv17 frozenでの順位が一致**(E1: seed1<seed3<seed2、E2: seed1<seed2<seed3)。ただし静的MAEは対局ゲート結果を代替しないため、最終判定は後続のvs Edax lv12ゲートで行う。

17. **E1/E2学習完了・ベストseed確定**: E1ベスト=seed1(`train/data/t181/e1-v0002/t158-b3-canonical-seed-1-earlystop.bin`)、E2ベスト=seed1(`train/data/t181/e2-mixed/t158-b3-canonical-seed-1-earlystop.bin`)。次工程: 対局ゲート前のT180/T182再確認→vs Edax lv12 60局ゲート(E1-best、E2-best各々)。

18. **ゲート前のT180/T182再確認**: `tasks/STATUS.md`確認。T180は完了済み(`59b5c41`)。T182は`review保留`のまま、状態は変わらず「NPS再計測をT181完了後のCPU専有ウィンドウまで延期」と明記。**T182側の`engine/src/search.rs`変更は既に`bd9ccaa`でコミット済み**(`git status --short`で確認、未コミット差分なし)であり、以後T182がこのタスクの完了(=T181のCPU専有終了)を待つのみで、追加のコード変更を並行して行う計画ではない。ゲート(`eval_cli`が依存する`engine::search`)は現在mainにある安定コードを使えばよく、**競合なしと判断してゲートを続行**。`cargo test -p train --release`(全ターゲット、train_patterns_v3.exe含む)108+件超・全パスも確認済み(17節)。ゲート完了後はT182側の専有ウィンドウが開くことを完了報告に明記する。

19. **v6基準線(T174)の再利用可否判定(スポットチェック)**: `git log 95e9e8d..HEAD -- engine/`(T174コミット以降)で4コミット(T175 `2e9bb88`・T176 `f1fdbbd`・T178 `9e50fc7`・T182 `bd9ccaa`)を確認、`eval_cli`再ビルドSHA-256`2a0b329e...`はT174時点の`cfd600e6...`と不一致(再ビルド差分あり、想定どおり)。T169前例(1件でも不一致ならbaseline再利用不可・新規実行)に従い、v6重みで`--opening-limit 3`(先頭3開幕=6局、`--allow-dirty --no-resume`)のスポットチェックを実行し、T174の生JSON(`bench/edax-compare/endgame-results/t174-v6-vs-edax-lv12-results.json`)先頭6局と全フィールド突合(Python)した。結果: **margin/plies/move/board_before/nodes/depth/discDiff/timedOut/nodeLimitHit/exactFallbackは6局全て完全一致**、差異は`elapsedMs`・`nps`(実行時のwall-clock計時値、ノード予算160,000到達までの実時間で機械依存・毎回変動が期待される非決定性フィールド)のみだった。ノード数固定(160,000)到達による着手選択は再現性のある決定的経路であり、局面選択・探索結果に影響する全フィールドが一致したため、**T174のv6 lv12基準線(60局、18勝1分41敗、平均-6.067石)は再利用可能と判定し、v6の新規60局実行は行わない**(T169は実際に1件の意思決定フィールド不一致(着手順序)を検出したため新規実行が必須だったが、本件はそれに該当する差異が皆無)。スポットチェック成果物は`bench/edax-compare/endgame-results/t181-v6-lv12-spotcheck-{results.json,report.md}`(ローカルのみ、gitignore対象外だが軽量なため後でレポートと共にコミット検討)。

20. **E1-bestゲート実行(60局)**: T174と同一プロトコル(single-root、primary 30開幕、depth12・exact-from-empties16・quota60%・max-nodes160000・time-ms1500・tt-mb64・unlimited-exact-empties20、`--skip-loss-analysis`)、重み`train/data/t181/e1-v0002/t158-b3-canonical-seed-1-earlystop.bin`。08:00:49開始〜完走(約13分)、60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空(異常0件)。**結果: 17勝3分40敗、平均石差-10.77石**(v6の-6.07石より悪化)。生JSON: `bench/edax-compare/endgame-results/t181-e1-vs-edax-lv12-results.json`(gitignore領域)。

21. **E2-bestゲート実行(60局)**: 同一プロトコル、重み`train/data/t181/e2-mixed/t158-b3-canonical-seed-1-earlystop.bin`。08:13:17開始〜完走(約13分)、60/60局、fixed-depth決定性40/40・node-budget決定性10/10ともPASSED、stderr空(異常0件、timedOut 0件・wall保険発動0件、engine着手1476手)。**結果: 14勝4分42敗、平均石差-8.80石**(v6の-6.07石より悪化)。

22. **統計判定(paired bootstrap、T158d/T162/T166/T169と同一実装)**: `compare_pattern_v3.py`の`paired_bootstrap()`と同一アルゴリズムをスクリプトで再実装(`random.Random(seed)`・重複ありresample・100,000標本・percentile 95%CI)+符号検定(exact two-sided binomial, p=0.5)。開幕単位(n=30、primary-01〜30昇順)・局単位(n=60、開幕昇順→黒番→白番)の両方を算出。
    - **E1 vs v6**: 開幕単位 平均差-4.700、CI[-7.633,-1.967](seed=181001、**完全に0より下=有意悪化**)、符号検定9勝18敗p=0.1221。局単位: 平均差-4.700、CI[-7.300,-2.233](seed=181002)、符号検定19勝34敗p=0.0534。
    - **E2 vs v6**: 開幕単位 平均差-2.733、CI[-5.533,-0.067](seed=181003、**完全に0より下=有意悪化**)、符号検定9勝17敗p=0.1686。局単位: 平均差-2.733、CI[-5.433,-0.133](seed=181004)、符号検定20勝32敗p=0.1263。
    - 数値はraw JSON(勝敗数・平均石差)からPython独立再計算し照合済み(0件不一致)。

23. **採用提案の規準当てはめ**: 事前登録規準「CI完全プラスのみ採用提案」に対し、E1・E2いずれも開幕単位CIが**完全に0より下**(有意改善どころか有意悪化)であり、**両構成とも規準を満たさない。採用は提案しない。**

24. **レポート作成**: `bench/edax-compare/t181_v0002_report.md`+`.meta.json`を新規作成。データ取得・変換仕様・分布比較(全51バケット最大乖離0.0116ポイント)・学習表・共有frozen比較・ゲート結果・統計・採用判定・結論(ユーザー仮説は本実験では支持されず、E2>E1だがいずれもv6に劣る、混合効果とv0002自体の寄与は本実験では未分離)を記載。record数値(勝敗・平均石差)・checkpoint数値をPythonで独立再計算しmeta.jsonと突合、0件不一致を確認。`cargo test -p train --release`・`cargo test -p engine --release`いずれも全パス(warning/failure 0件)を再確認。

25. **T182連携**: ゲート完了によりT182が待っていたCPU専有ウィンドウが利用可能になったことをレポート6節に明記。

26. **コミット・完了確認**: `bench/edax-compare/t181_v0002_report.md`+`.meta.json`をパス明示でコミット(`git add -A`不使用)。データ本体・生対局ログ・スポットチェック結果はいずれも既存`.gitignore`ルールでローカルのみ(コミット対象外を確認)。作業中に誤ってリポジトリ直下へ書き出した中間集計ファイル(`bench/edax-compare/t181_gate_stats.json`)は削除済み。`git status --short`は本タスクファイル編集分を除きクリーンであることを確認。

### 2026-07-22 verifier検収(合格)

受け入れ基準1〜4および運用ルール(コミット規律・gitignore・test)をすべて独立に再検証した。

1. **ゲート統計の独立再計算**: 生JSON(`bench/edax-compare/endgame-results/t174-v6-vs-edax-lv12-results.json`・`t181-e1-vs-edax-lv12-results.json`・`t181-e2-vs-edax-lv12-results.json`)をPythonで独立に読み込み、`margin_engine_minus_edax`からW/D/L・平均石差を再集計: v6=18/1/41/-6.0667、E1=17/3/40/-10.7667、E2=14/4/42/-8.8(いずれもレポートと完全一致)。`compare_pattern_v3.py`の`paired_bootstrap()`(`random.Random(seed)`+`rng.choice`+`percentile(fraction)=means[round(fraction*(len(means)-1))]`)を同一実装でスクリプト化し、開幕単位(per-opening平均、id昇順)・局単位(id昇順→黒→白のインターリーブ、報告書の値と突合してこの並び順であることを確定)の両方で再現: E1 opening CI=[-7.633,-1.967]、E1 game CI=[-7.3,-2.233]、E2 opening CI=[-5.533,-0.067]、E2 game CI=[-5.433,-0.133]、符号検定(pos/neg/p)もすべて桁まで完全一致。両CIとも開幕単位で完全にマイナスであることを確認(規準どおり不採用)。v6基準線(T174再利用)の妥当性は、T174コミット以降の`engine/`差分4件(T175/T176/T178/T182)とspotcheck(先頭6局、move/board_before/nodes/depth/discDiff/timedOut/nodeLimitHit/exactFallback/margin/pliesが完全一致、elapsedMs/npsのみ差異)の記録を確認、T169前例の判定基準に整合。
2. **共通frozen比較の追試**: `cargo build --release -p train --bin frozen_mae_eval`後、`train/data/t181/lv17_frozen.txt`(3,189,392行、既存キャッシュ)を使い、v6/e1-seed1/e2-seed1の3重みで再実行し、v6=4.492196、e1-seed1=4.968667、e2-seed1=4.784592を再現(レポート完全一致)。重みファイルのSHA-256(`e1-v0002/...seed-1-earlystop.bin`=`fc394046...`、`e2-mixed/...seed-1-earlystop.bin`=`f9de1839...`)もmeta.json記載値と一致。学習からのfrozen除外設計(`split_by_position_hash`がデータソース非依存の純粋関数であるため、E1/E2の学習コーパスからlv17 frozenと同一ハッシュ判定になる局面は自動的に除外される)は`bench/edax-compare/t181_v0002_report.meta.json`の`frozenSplitMechanism`に明記されていることを確認。
3. **変換の検証(サンプル)**: (a) `train/data/t181/v0002_25m.txt`(24,919,545行)からランダム2,000行を抽出し正規表現`^[XO-]{64} -?\d+$`で全件マッチ、盤面石数・スコア範囲も異常なし。(b) checkpoint(`v0002_25m.checkpoint.json`)の`per_bucket_written`集計がレポート本文のバケット別採用数(空き1=487,947・2=489,629・3=491,128・25=490,214・26=490,047・48=490,400・50=489,839・51=424,603)と完全一致、`samples_written`(24,919,545)・`output_bytes_committed`(1,699,033,615)が実ファイルの行数・バイト数とも一致することを確認。(c) 独立実装のPython版Othelloリプレイヤー(engineのコードを一切参照せず標準ルールを新規実装)で`egaroucid_v0002/extracted/zip0/.../8/0000000.txt`の100局を再生し、ランダム序盤除外(フォルダ名N=8として`samples[0..N)`除外)後の候補局面5,199件(uniq)のうち378件が変換出力ファイル中に完全一致する行(64文字盤面+半角スペース+スコア)として実在することを確認 — この一致は「盤面+ラベル」の組み合わせでの厳密一致であり、独立再生した最終石差ラベルが変換出力のラベルと整合していることを裏付ける。
4. `cargo test -p train --release`: 全ターゲット合計158+件、0 failed(train_patterns_v3.exe含む全バイナリ、frozen_mae_evalの3テスト含む)。`cargo test -p engine --release`: 245 passed/0 failed/2 ignored(ignoredはFFO重量級テスト、既知の意図的スキップ)。データ本体のコミット確認: `774db9f`(frozen_mae_eval.rs+tsvのみ)・`e0e0814`(report.md+meta.jsonのみ)・`a45b02c`(convert.rsのみ)・`d2fd124`(simple_corpus.rs差分のみ)を`git show --stat`/`git ls-tree -r -l`で確認、いずれも大容量データファイルなし。`git check-ignore -v`で`train/data/t181/*`・`train/data/egaroucid_v0002`・`bench/edax-compare/endgame-results/t181-*-results.json`が全て`.gitignore`ルールでignore対象と確認。
5. `git status --short`: 検証開始時点でクリーン(本追記のみ)。
6. コード修正なし・学習/対局の再実行なし(frozen_mae_evalの再実行のみ、既存キャッシュ・既存重みファイルを読むだけの読み取り検証)。

**総合判定: 合格**。全受け入れ基準・追加検証観点(paired統計の独立再計算、frozen比較の追試、変換サンプルの独立リプレイ照合)を満たすことを確認した。
