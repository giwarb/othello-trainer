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
