---
id: T154
title: 混合学習の同一トレーナー対照: WTHOR/Egaroucid/混合を@同条件で比較(軽ステップ)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T154: 混合データ対照実験

## 目的

「Egaroucid公開データで本番(v4×WTHOR、oracle 1.111)を超えられるか」を判断する前段として、**同一トレーナー(t090 simpleモード)内で**WTHOR・Egaroucid・混合を対照する。T153の結果(@90万でEgaroucid 1.867)はトレーナー交絡(v4×WTHOR 1.111は別トレーナー train_patterns_v3 の結果)があり直接比較できないため、まず交絡の大きさ自体を測る。

## 事前登録の設計と解釈

3run(すべて v4・teacher-only(simple)・seed1・--jobs 1・t090 simpleモード・T096 oracle 60局面+M2ガード):

- **Run A: WTHOR全局面 simple化 @約443万** — WTHOR棋譜(train/data/*.wtb、74,024局)の全手を(盤面, 手番側最終石差)のsimpleレコードへ変換して学習。**train_patterns_v3の1.111と同じデータ・同じ特徴で、トレーナーだけ違う**構成。A vs 1.111 の差=トレーナー差の実測。
- **Run B: Egaroucidのみ @約443万**(2,551万からの決定的サブセット、T153の入れ子拡張)— データ差の実測(A vs B)。
- **Run C: 混合 = WTHOR全量443万 + Egaroucid石数15以下全量**(lv17網羅ラベルが確実な部分、README表では4〜15石合計約143万件想定・実測すること)— 「量を積む+序盤の質を足す」の効果(C vs A)。

解釈: (1) A≈1.1台ならトレーナー差は小さく、B/CがAを下回れば本番超え候補としてフル/大規模学習(重い、別タスク)へ。(2) Aが1.5〜1.9等で大きく劣るなら、t090トレーナー側の差(損失形・LR・重み付け)が支配的 → 今後は「良いデータをtrain_patterns_v3側に取り込む」方向へ転換(その場合B/Cの絶対値は参考扱い)。

## 要件

1. **WTHOR simple化ツール**: train/src/train_data.rs の samples_from_game(1手=1サンプル・手番側最終石差)を再利用し、全74,024局→simpleレコード(t090 simpleモードが読める形式)へ決定的に変換する小さなRust bin(またはt090への読込モード追加)。件数(約443万)を実測記録。出力はgitignore領域。
2. **サブセット**: Bは既存の--simple-max-records+層化サブセット機構で443万に合わせる(Aの実測件数と一致させる)。Cは連結(WTHOR全量+Egaroucid石数≤15全量)。混合時のレコード重複(同一局面が両ソースに存在)は除去しない(重み付けの一形態として容認、件数内訳をレポート)。
3. 3runの学習+oracle評価(M2ガード各回)。1runの学習は443万×数十epochで20〜40分想定。**epoch checkpoint/resume+進捗ログ必須**、フォアグラウンド直列またはStart-Process detach+ポーリング(Bashバックグラウンドはツール境界で死ぬ既知事象があるため禁止)。
4. レポート: bench/edax-compare/t154_mixed_data_probe_report.md(+meta)に3runの結果・事前登録解釈への当てはめ・次の一手の客観所見。コミット・push。

## スコープ外

- フル25.5M学習・対局ゲート・本番採用(結果を見て別途判断)
- train_patterns_v3側の改修(解釈(2)になった場合の将来タスク)
- app/engine変更(Pages確認不要)

## 受け入れ基準

1. 3runのoracle regretがM2ガード記録付きでレポートにあり、事前登録解釈への当てはめが明記されている
2. Run Aの件数がWTHOR trainerの実績(train+frozen=4,431,504サンプル、内訳: train 3,988,509)と整合する説明がある(全局面variantとtrain split相当の対応を明確に)
3. `cargo test -p train` 全パス(変換ツールのテスト込み)、既定挙動不変
4. コード・レポートのみパス明示でコミットしmainへpush、データ非コミット、完了時 `git status --short` クリーン

## コミット規律

- 変更対象のみパス明示add。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)
- 学習実行中は他の重い処理と並行しない(T151の残作業はPages確認のみで軽い)

## 作業ログ

### 2026-07-20 実装開始・データ準備完了

- 既存コード調査: `train/src/t090_distillation.rs`の`--simple-corpus`(T153導入)は既に
  `<64文字盤面> <スコア>`テキストを読み、`fnv1a(canonicalKey)%100`でtrain0-89/
  validation90-94/frozen95-99(discarded)に分割する。改修不要、そのまま3run全てに使う。
- `train/src/bin/wthor_to_simple.rs`(新規)を実装: `train::train_data::samples_from_game`
  (既存、改修なし)を再利用し、WTHOR全`.wtb`(`train/data/*.wtb`、`train_patterns_v3`の
  `data_files()`と同じファイル列挙規則)を`--simple-corpus`互換のテキストへ決定的に変換。
  5件のユニットテスト(64文字盤面・整数スコア出力、mover視点でのX/O入れ替わり確認、
  盤面+outcomeの往復一致、決定性)を追加。
- `train/src/bin/egaroucid_filter_stones.rs`(新規)を実装: Egaroucid公開データ
  (25,514,097行)から盤面上の石数(X+O)が`--max-stones`(既定15)以下の行を決定的に
  抽出する(行の書式は変更しない、そのまま`--simple-corpus`に食わせられる)。4件の
  ユニットテストを追加。
- `cargo test -p train --release`: **99 passed, 0 failed**(既存99件中訳: 74(t090_distillation)
  +4(train_data)+2(regression)+3(train_patterns_v3)+10(wthor_lines)+1(real_data統合) に
  新規9件(wthor_to_simple 5件 + egaroucid_filter_stones 4件)を加えた合計)。既定挙動不変
  (`t090_distillation.rs`・`train_data.rs`は無改修)。
- 実データ変換実行(コミット対象外、`train/data/`は既存gitignore):
  - `wthor_to_simple.exe --data-dir train/data --out train/data/t154/wthor_all.txt`
    → **4,431,504件**(74,024局・invalid 0・empty 0、25ファイル)。
    `train_patterns_v3`実績の train 3,988,509 + frozen 442,995 = **4,431,504と完全一致**
    (両ツールとも同じ`data_files()`列挙規則・同じ`samples_from_game`を使うため当然の一致。
    ただし内訳の分割方法は異なる: `train_patterns_v3`は対局単位で末尾10%を frozen に
    ホールドアウトする一方、t090 simpleモードは局面(canonicalKey)単位の
    `fnv1a%100`分割で train90%/validation5%/frozen(discarded)5%にする。Run Aの
    実際のtrain件数は後者の規則で決まるため、3,988,509とは近似するが完全一致はしない
    見込み — 学習実行後の`manifest.txt`で実測し、レポートに整合説明を記載する)。
  - `egaroucid_filter_stones.exe --in-dir train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17
    --out train/data/t154/egaroucid_le15.txt --max-stones 15`
    → **1,514,097行**(scanned 25,514,097・malformed 0)。石数別内訳:
    4:1, 5:1, 6:3, 7:14, 8:60, 9:322, 10:1,773, 11:10,649, 12:67,245, 13:434,029(T153報告の
    README引用値と一致), 14:500,000, 15:500,000。事前見積り(README表からの概算約143万件)
    よりやや多い実測値(151万件、14石・15石が満杯500,000ずつ含まれるため)。
  - `cat wthor_all.txt egaroucid_le15.txt > mixed_c.txt` → **5,945,601行**
    (4,431,504+1,514,097、Run C用連結プール。重複除去はしない、要件どおり)。
- 次: Run A(WTHOR全量、`--checkpoint-dir train/data/t154/wthor-v4`)をPowerShell
  Start-Process detachedで起動し、ログ`logs/t154-wthor-v4.stdout.log`をポーリングする。

### 2026-07-20 Run A完了・Run B起動

- **Run A完了**(`target/release/train_distillation.exe --simple-corpus train/data/t154/wthor_all.txt
  --checkpoint-dir train/data/t154/wthor-v4 --pattern-set v4 --seeds 1 --jobs 1 --max-epochs 60`)。
  manifest: pool=4,431,504, train=4,011,443, validation=196,581, frozen_discarded=223,480
  (`fnv1a(canonicalKey)%100`局面単位分割。`train_patterns_v3`の対局単位分割による
  train=3,988,509/frozen=442,995とは分割方式が異なるため完全一致しないが、
  同一入力4,431,504件から生成しておりtrain比率もほぼ同水準(90.5% vs 90.0%)で整合)。
  result.tsv: best_epoch=23, completed epoch=25(patience 5で早期終了), train_teacher_mae=13.197257,
  validation_loss=47.877210, validation_teacher_mae=13.763418。
  final.bin sha256=426af4b8d163b01791d0dbfd7c665c525a02e8c3bbdc8572aa388ace51bb17a1。
  Monitorツールの完了通知がセッションに届いていなかった(オーケストレーター指摘)ため、
  以後は「PowerShell Start-Process detached起動 → Bashツールで短時間の定期チェックを
  繰り返す(1呼び出し内で数分程度のsleep+result.tsv存在確認ループ、未完了なら次の
  ツール呼び出しで継続)」方式にポーリングを切り替える。
- **Run B起動**: `target/release/train_distillation.exe --simple-corpus
  train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --checkpoint-dir train/data/t154/egaroucid-v4
  --pattern-set v4 --seeds 1 --jobs 1 --max-epochs 60 --simple-max-records 4431504 --subset-seed 42`
  (Run Aのpool件数4,431,504にreservoir samplingで一致させる、既定subset-seed=42)。
  PID確認済み、ログ`logs/t154-egaroucid-v4.stdout.log`をポーリング中。

### 2026-07-20 Run B完了・Run C起動

- **Run B完了**。manifest: simple_corpus_total_lines=25,514,097(Egaroucid全量),
  simple_corpus_pool_size=4,431,504(reservoir samplingでRun Aのpool件数に一致させた),
  train=3,982,785, validation=210,235, frozen_discarded=238,484(Run Aのtrain 4,011,443/
  90.5%に対しB train 3,982,785/89.9%、比率はほぼ同水準)。
  result.tsv: best_epoch=42, completed epoch=42, train_teacher_mae=4.212934,
  validation_loss=14.918887, validation_teacher_mae=5.364459
  (WTHORのvalidation_loss 47.88より大幅に低いが、これは学習損失のスケールの話であり
  評価指標としてはoracle regretで比較する)。
  final.bin sha256=8bc5977f834911bbaa055fd98c7462509e3e4e231c56aa80a559314de7da846b。
- **Run C起動**: `target/release/train_distillation.exe --simple-corpus
  train/data/t154/mixed_c.txt --checkpoint-dir train/data/t154/mixed-v4 --pattern-set v4
  --seeds 1 --jobs 1 --max-epochs 60`(混合5,945,601件、subsetなし全量、自然な
  90/5/5分割に任せる)。PowerShell Start-Process detachedで起動、Bashツールでの
  定期チェック方式(30秒間隔・result.tsv出現確認)でポーリング中。

### 2026-07-20 Run A・BのOracle評価完了(M2ガードPASS)、Run C学習中

Run Cの学習(train=5,368,814、pool=5,945,601)と並行して、Run A・Bのoracle評価を実行
(`compare_pattern_v3.py`、T096 60局面)。両方ともv2 mean regretが既知値
`1.5666666666666667`と完全一致(**M2ガードPASS**)。

- Run A(WTHOR全量@t090トレーナー): candidate mean regret = **1.5**(diff -0.0667 vs v2,
  95%CI [-0.767, 0.667]、no_significant_difference)。出力:
  `train/data/t154/oracle/wthor-v4-seed-1.json`。
  **train_patterns_v3で同一4,431,504件を学習した既知値(T124) 1.1111 と比べ明確に劣る
  (+0.39)** → 事前登録の解釈(2)(「Aが1.5〜1.9等で大きく劣るならt090トレーナー側の差
  (損失形・LR・重み付け)が支配的」)に該当する可能性が高い一次所見。
- Run B(Egaroucid@Run Aと同pool件数4,431,504): candidate mean regret = **1.2333**
  (diff -0.3333 vs v2, 95%CI [-0.967, 0.333]、no_significant_difference)。出力:
  `train/data/t154/oracle/egaroucid-v4-seed-1.json`。
  **B(1.2333) < A(1.5)、同一トレーナー・同一pool件数でEgaroucidデータの方が良好**
  (データ差=-0.2667)。n=60のため両者ともv2比では有意差なしだが、A・B間の相対順位
  (B<A)は一貫した方向のシグナル。
- Run C起動: `target/release/train_distillation.exe --simple-corpus train/data/t154/mixed_c.txt
  --checkpoint-dir train/data/t154/mixed-v4 --pattern-set v4 --seeds 1 --jobs 1 --max-epochs 60`。
  manifest: pool=5,945,601, train=5,368,814, validation=260,795, frozen_discarded=315,992。
  Bashツールでの定期チェック方式でポーリング中(Aよりtrain件数が約34%多いため、
  1epochあたりの所要時間も比例して長くなる見込み)。

### 2026-07-20 Run C完了・全3runのOracle評価完了・レポート作成・コミット/push完了

- **Run C完了**: best_epoch=17, completed=22, train_teacher_mae=10.733194,
  validation_loss=37.615572, validation_teacher_mae=11.115042。
  final.bin sha256=df82ca4808c91c5e5f546c64ffe54314d431a40b671100bc3dcbb35a2f8f6a55。
- **Run Cのoracle評価**: v2 mean regret 1.5666666666666667(M2ガードPASS)、
  candidate mean regret = 1.4333(diff -0.1333, 95%CI [-0.800, 0.533]、
  no_significant_difference)。出力: `train/data/t154/oracle/mixed-v4-seed-1.json`。
- **3run最終結果まとめ**(全てM2ガードPASS): A(WTHOR全量)=1.5000, B(Egaroucid同pool)
  =1.2333, C(混合)=1.4333。既知値: v4×WTHOR(train_patterns_v3, T124)=1.1111,
  v2×WTHOR=1.5667。
  A=1.5000は事前登録の解釈(2)の帯域(1.5〜1.9)に該当 →
  train_patterns_v3の既知値1.1111との差(+0.3889)は同一データ・同一パターンセットで
  トレーナーだけが違う構成から生じており、t090トレーナー側の差が支配的と判断。
  B<C<A(1.2333<1.4333<1.5000)という順序自体はEgaroucidデータの質を示す副次的シグナル
  だが、解釈(2)に従いB/Cの絶対値は参考扱いとし、「本番超えのフル学習」への直行は
  推奨しない(次の一手は「t090トレーナーとtrain_patterns_v3の差分要因の特定」または
  「良質データをtrain_patterns_v3側へ取り込む」方向、別タスクで判断)。
- レポート`bench/edax-compare/t154_mixed_data_probe_report.md`と
  `bench/edax-compare/t154_mixed_data_probe.meta.json`を作成。
- `cargo test -p train --release`: 99 passed, 0 failed(最終確認)。
- コミット(パス明示、tasks/とCLAUDE.mdは対象外): `train/src/bin/wthor_to_simple.rs`,
  `train/src/bin/egaroucid_filter_stones.rs`,
  `bench/edax-compare/t154_mixed_data_probe_report.md`,
  `bench/edax-compare/t154_mixed_data_probe.meta.json`。
  コミット f2c6c88、`git push origin main`成功(`7bec0b0..f2c6c88 main -> main`)。
  `train/data/t154/`配下(変換済みコーパス・checkpoint・weights・oracle出力)は
  既存の`train/data/`gitignoreにより非コミット。
- 受け入れ基準セルフチェック: (1)3runのoracle regret+M2ガード記録+解釈への当てはめ →
  レポート内に記載済み。(2)Run Aの件数整合説明 → レポート「Data preparation」節に記載
  (合計4,431,504は完全一致、分割方式の違いにより実train数は近似一致)。(3)cargo test -p
  train全パス → 確認済み。(4)コード・レポートのみコミット・push、データ非コミット →
  完了(git statusは`tasks/T154-mixed-data-probe.md`の作業ログ追記のみ残存、これは
  オーケストレーターの担当としてコミットしない)。
