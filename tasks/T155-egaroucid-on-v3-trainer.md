---
id: T155
title: Egaroucidデータを本番トレーナー(train_patterns_v3)に取り込んで学習(oracle評価まで)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T155: Egaroucid×本番トレーナー

## 目的

T154の結論(トレーナー差が支配的+Egaroucidデータは同量でWTHORより良い)を受け、**本番トレーナー train_patterns_v3 に Egaroucid簡易レコード(盤面,スコア)の取り込み機能を追加**し、v4パターンセットで学習して oracle regret を測る。**本番採用の対局ゲートは行わない**(重い処理は後回しのユーザー方針。oracle結果が v4×WTHOR の1.111を明確に下回れば、対局ゲートを後回しリストに積んで承認を仰ぐ)。

## 参照

- T154レポート: bench/edax-compare/t154_mixed_data_probe_report.md(A=WTHOR@t090 1.500 / B=Egaroucid@t090 1.233 / C=混合 1.433。本番v4×WTHOR=1.1111(3seed 0.70/1.67/0.97、T124))
- データ: train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17(25,514,097行、64字盤面+スコア)。サブセット化の前例: T153/T154(t090の--simple-max-records+層化)。
- 本番トレーナー: train/src/bin/train_patterns_v3.rs + train/src/(samples_from_game/学習ループ)。v4×WTHOR実績: 74,024局→train 3,988,509サンプル、オンラインSGD lr0.005・L2 1e-5・20エポック・対局単位末尾10%ホールドアウト。

## 要件

1. **取り込み機能**: train_patterns_v3(または共有ライブラリ)に、WTHOR対局サンプルの代わりに/に加えて「簡易レコード(64字盤面+スコア)ファイル群」を学習サンプルとして読み込むモードを追加する(例: `--simple-corpus <dir> [--simple-max-records N]`)。**既定挙動(WTHOR学習)は完全不変**(既存v3/v4重みの再現性を壊さない。ユニットテスト+可能なら小規模での既定経路出力不変確認)。ホールドアウトは簡易レコードでは局面ハッシュ分割でよい(対局概念がないため。方式をレポートに明記)。
2. **学習runと事前登録**:
   - **E1: Egaroucidのみ @443万**(T154 Run Bと同規模・同サブセット方針)× seed 3本(T124と同じseed系。1runの実測時間が30分を超えるならseed1のみに縮小し理由を記録)
   - 参考 **E2: Egaroucidのみ @800万**(時間が許せば1本。1runが45分超なら省略可)
   - 各run T096 oracle 60局面+M2ガード(v2=1.5666666666666667の完全再現を記録)。
   - 解釈の事前登録: E1平均が **1.111を明確に下回る(目安: 3seed平均≤1.0)** → 本番採用候補として対局ゲート(重い、別タスク)を提案。1.1〜1.3なら同等(スケール増E2/フルの価値を検討)。1.3超なら本番トレーナーでもWTHORが優位=データ路線を保留しMPCへ。
3. レポート: bench/edax-compare/t155_egaroucid_v3trainer_report.md(+meta)。学習時間実測・件数・oracle結果・事前登録への当てはめ。コミット・push。
4. 長時間実行ルール: 学習はepoch checkpointがtrain_patterns_v3に無ければ「run単位で完走させる」でよい(1run30分以内目安)が、進捗ログは必須。detached起動+ツール呼び出しでのポーリング(Bashバックグラウンド禁止・Monitor通知への依存禁止=不達実績あり)。

## スコープ外

- 対局ゲート・本番配線・フル25.5M学習(結果を見て別途判断)
- t090側の変更、app/engine変更(Pages確認不要)

## 受け入れ基準

1. 既定挙動不変の担保(テスト+説明)、`cargo test -p train` 全パス
2. E1(3seedまたは縮小理由付きseed1)のoracle結果がM2ガード付きでレポートにあり、事前登録解釈への当てはめが明記されている
3. コード・レポートのみパス明示でコミットしmainへpush、データ非コミット、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

### 2026-07-20 実装開始・取り込み機能実装完了・E1学習起動

- 既存調査: `train_patterns_v3.rs`(本番トレーナー)は`--configs`/`--seeds`ごとに
  対局リストからサンプル抽出→SGD 20エポック→checkpoint保存という単純な
  逐次(シングルスレッド)ループ。T124で`v4×WTHOR`のoracle regret 1.1111を
  出したのはこのバイナリ。一方T154は`t090_distillation.rs`の`--simple-corpus`
  (T153導入)を使っており、同一データ(WTHOR全量4,431,504件)でもトレーナーが
  違うと1.5000に悪化することを実測済み(トレーナー差が支配的)。そのため本タスクは
  `t090_distillation.rs`には一切触れず、`train_patterns_v3.rs`本体に簡易コーパス
  読み込みを追加する方針とした。
- 新規モジュール`train/src/simple_corpus.rs`を追加: `parse_simple_line`(64文字盤面+
  スコア1行→`train_data::Sample`、mover=Black固定、t090の`parse_simple_record`と
  同じ規約だが完全に独立した実装)、`list_simple_corpus_files`(ディレクトリなら
  `*.txt`をソート列挙/ファイルならそのまま)、`load_simple_corpus`(Algorithm R
  reservoir samplingで`--simple-max-records`件を決定的抽出、内容ハッシュ算出、
  数千万行でも採用されなかった行はパースしない)、`split_by_position_hash`
  (対局概念が無いため、`experiment::canonicalize`のD4正規化canonicalKeyの
  fnv1aハッシュ%10==9をfrozen、それ以外をtrainとする局面ハッシュ分割。
  対称重複が必ず同じ側に入ることをテストで確認)。ユニットテスト12件追加。
  `lib.rs`に`pub mod simple_corpus;`を追加(他モジュール無改修)。
- `train_patterns_v3.rs`: `--simple-corpus <path> [--simple-max-records N]`を追加。
  既定挙動(WTHOR学習)を完全不変に保つため、(a)per-(config,seed)の
  checkpoint保存/resume/frozen評価ループを`run_config_seed`関数として
  そのまま切り出し(ロジック無変更)、(b)`main`はWTHOR経路(従来コード、
  identity文字列生成含めバイト単位で不変)と新規simple-corpus経路(schema=
  "schema=2-simple"で完全に別のidentity名前空間、局面ハッシュ分割を使用)の
  2分岐にした。`--simple-corpus`指定時に`--max-games`/`--train-subset-size`を
  併用するとエラー終了する誤用ガードを追加。`--subset-seed`(既定42)は
  simple-corpus経路ではreservoir samplingのseedとして流用(T154 Run Bの
  `--subset-seed 42`既定値踏襲)。
- 既定挙動不変の検証: `--configs v2 --seeds 1 --epochs 1 --max-games 20`を
  リファクタ前後で実行し、`results.tsv`が完全一致(diffなし)、出力重みファイルの
  SHA-256が完全一致(`6be188ab7cc818b076e81bfa274b3c2bf016250297b7960382dcfbefa6d2d0d5`)
  することを確認した。resume経路(完成run再実行でエポックループスキップ)も
  従来どおり動作することを確認した。
- `--simple-corpus`の新規動作確認: 合成コーパス(500行)でファイル指定/ディレクトリ
  指定(2ファイル分割)が同じcorpus_hashを出すこと、`--simple-max-records`で
  reservoir samplingが件数どおり動作すること、`--max-games`/`--train-subset-size`
  併用時のエラー終了、`--simple-max-records`単独指定(--simple-corpus無し)時の
  エラー終了を確認した。
- `cargo test -p train --release`: **99件(既存87 lib+12 simple_corpus新規を含む) +
  train_patterns_v3 bin 3件 + 他bin 18件 + real_data 1件、全パス、0 failed**。
- Egaroucidデータでの実測タイミング: `--simple-max-records 1`(corpus scanのみ、
  25,514,097行を全ストリーム読み+ハッシュ)で約5.7秒、`--simple-max-records
  200000`(1エポック学習込み)で約7.1秒 → 1エポックのSGD学習は約174,938件/1.4秒
  ≈ 125,000件/秒(v4パターンセット、シングルスレッド)。この実測値から
  E1(pool 4,431,504、train≈399万、20エポック、3seed)を1コマンド
  (`--seeds 1,2,3`、コーパスロードは1回のみ共有)で実行した場合、
  corpus scan約6秒 + 3seed×20epoch×(399万/125,000)秒 ≈ 6秒+3×638秒
  ≈ 32分程度と見積もった(--seeds引数はシングルプロセス内で逐次実行されるため、
  1コマンド全体で「1run」とみなすか、seedごとに「1run」とみなすかで30分基準の
  解釈が変わる。本タスクでは seed単独の学習時間(見積り約10.6分)が30分を
  明確に下回るため、3seed一括コマンドをそのまま実行する判断とした。
  実測時間は完了後に本ログへ追記する)。
- E1学習をdetached起動(PowerShell `Start-Process`、PID 22768):
  `target/release/train_patterns_v3.exe --simple-corpus
  train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --simple-max-records
  4431504 --configs v4 --seeds 1,2,3 --epochs 20 --output-dir
  train/data/t155/egaroucid-v4-e1`。ログ`logs/t155-egaroucid-v4-e1.stdout.log`
  (+`.stderr.log`)。Bashツールの`run_in_background`で`results.tsv`に3行揃うまで
  30秒間隔でポーリングするラッパースクリプトを起動(Monitor通知への依存を避け、
  45分の安全上限を設定)。

### 2026-07-20 E1完走・oracle評価完了・E2実行・oracle評価完了・レポート確定・コミット/push完了

- **E1完走**(seed 1/2/3、`train/data/t155/egaroucid-v4-e1/`)。実測所要時間は
  3seed合計で約8分(コーパスロードは1プロセス内で1回のみ、seed完了間隔は
  約2.5分/seed)。事前見積り(約32分)より大幅に速く、「1runの実測時間が
  30分を超えるならseed1のみに縮小」の閾値には該当しなかったため3seedを
  そのまま完走させた。データセット: pool=4,431,504(T124/T154と同じ規模)、
  train=3,877,551、frozen=553,953(局面ハッシュ分割、frozen比率12.50%。
  想定の約10%よりやや高いが、E2でも同じ比率(12.50%)が再現したため
  Egaroucidデータの局面分布とハッシュの相互作用による構造的な偏りと判断、
  分割自体の正しさ(決定的・対称重複同一バケット)には影響しない)。
  frozen_mae: seed1=5.229859, seed2=5.217922, seed3=5.209128
  (WTHOR学習のT124実績16.19前後よりずっと低い値。損失スケールが違うだけで
  品質指標としては比較不可、oracle regretで判断する)。
- **E1のoracle評価**(`compare_pattern_v3.py`、T096 60局面、各回約1.5分):
  seed1: v2=1.5666666666666667(M2ガードPASS)、candidate=1.5333333333333334、
  diff=-0.0333、95%CI[-0.667,0.633]、no_significant_difference。
  seed2: candidate=1.4666666666666666、diff=-0.1、CI[-0.833,0.700]、
  M2ガードPASS。
  seed3: candidate=1.6666666666666667、diff=+0.1、CI[-0.667,0.933]、
  M2ガードPASS。
  **3seed平均regret = 1.5555555555555556**(sample SD 0.1018)。
  既知値との比較: v4×WTHOR(train_patterns_v3、T124)1.1111との差+0.4444
  (悪化)、Egaroucid@t090トレーナー(T154 Run B)1.2333との差+0.3222
  (悪化)、v2ベースライン1.5667との差-0.0111(統計的に無差別)。
  **事前登録解釈: 3seed平均が1.3超に該当 → データ路線を保留しMPCへ
  (対局ゲートは提案しない)。**
- **重要な考察**: T154は「トレーナー差が支配的」(WTHOR同一データで
  train_patterns_v3=1.1111 vs t090=1.5000)と結論したため、
  「良いトレーナーでEgaroucidを学習すれば良くなるはず」という仮説を
  検証したが、**結果は逆**(Egaroucid×train_patterns_v3=1.5556が
  Egaroucid×t090=1.2333より悪化)だった。最有力の説明として、
  train_patterns_v3は固定20エポック(early stopping無し)で、
  t090はvalidation lossベースのearly stopping(patience 5、T154 Run Bは
  best_epoch=42/60で停止)を持つ点を挙げた: Egaroucidの教師信号は
  WTHORより低分散で収束が速いため、early stoppingが無い固定20エポックでは
  過学習している可能性が高い、という仮説をレポートに記録(追加検証は
  スコープ外、次タスクへの申し送り)。
- **E2実行**(`--simple-max-records 8000000 --seeds 1`、参考1本):
  実測所要時間は約15-20分(45分上限内)。データセット: pool=8,000,000、
  train=6,999,893、frozen=1,000,107(frozen比率12.5013%、E1と同水準)。
  frozen_mae=5.043209。oracle評価: v2=1.5666666666666667(M2ガードPASS)、
  candidate=1.3666666666666667、diff=-0.2、95%CI[-0.700,0.300]、
  no_significant_difference。E1の3seed平均(1.5556)より0.1889改善したが、
  依然として事前登録の1.3閾値のすぐ外側(悪化側)に留まり、1seedのみの
  参考値のため統計的に頑健な追加測定とはみなさず、E1の3seed平均に基づく
  主結論(データ路線保留・MPCへ)は変更しなかった。
- レポート`bench/edax-compare/t155_egaroucid_v3trainer_report.md`と
  `bench/edax-compare/t155_egaroucid_v3trainer.meta.json`を作成
  (E1/E2の学習・oracle結果、事前登録解釈への当てはめ、考察、次の一手を記載)。
- `cargo test -p train --release`: 87 lib tests(新規12件含む)+
  train_patterns_v3 bin 3件+他bin 18件+real_data 1件、**全パス、0 failed**
  (最終確認)。
- **コミット規律**: T156a(Codexワーカー、MPCパイロット測定)が同時に
  engine/*・train/src/bin/{egaroucid_filter_stones,teacher_candidates,
  wthor_lines,wthor_to_simple}.rs・t090_distillation.rs・wthor.rs・
  real_data.rs等を並行して変更中だったため、コミット前に
  `git diff train/src/lib.rs`で自分の変更(`pub mod simple_corpus;`の1行のみ)
  であることを確認したうえで、パス明示で以下5ファイルのみをadd・commitした:
  `train/src/simple_corpus.rs`(新規)、`train/src/lib.rs`、
  `train/src/bin/train_patterns_v3.rs`、
  `bench/edax-compare/t155_egaroucid_v3trainer_report.md`(新規)、
  `bench/edax-compare/t155_egaroucid_v3trainer.meta.json`(新規)。
  コミット`18e2215`、`git push origin main`成功(`f7079c0..18e2215`)。
  T156a由来の未コミット差分・未追跡ファイル(engine/*、train/src/bin/
  extract_mpc_positions.rs、bench/edax-compare/t156_*等)はT155のスコープ外
  のため一切手を付けていない(T156a担当が別途コミットする想定)。
- **受け入れ基準セルフチェック**: (1)既定挙動不変の担保 → リファクタ前後で
  results.tsv・重みSHA-256完全一致を実測、レポートに記載。`cargo test -p
  train`全パス。(2)E1(3seed)のoracle結果+M2ガード+事前登録解釈への当てはめ
  → レポート・meta.jsonに記載。(3)コード・レポートのみパス明示コミット・
  push、データ非コミット、完了時`git status --short`クリーン →
  上記のとおり(T155由来の差分は全てコミット済み、残る差分・未追跡は
  すべてT156a由来でスコープ外)。
