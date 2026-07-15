# T112 ラベル/損失対照実験 — 代替最終レビュー(Claude、Codex不可期間)

- 対象コミット: `3b0644d`(`train/src/t090_distillation.rs` のみ、+122/-8)
- タスク仕様: `tasks/T112-label-loss-ablation.md`
- レビュー方法: コード精読(コミット差分+周辺コード全経路)、T090b/T109/T110/T083 の既存記録との突合。読み取り専用(本レポート新規作成のみ)。
- レビュー日: 2026-07-16

## 総合判定: **合格**

実験結論を覆すコード上のバグは見つからなかった。outcome-only mix の実装・no-op ガード・M1' 順序修正はいずれも正しく、既存 mix(teacher-only / baseline / no-ranking)の数値挙動はコードパスとして厳密に不変であることを確認した。ただし、結論の記述に付すべき**限定条件(中2件)**があり、STATUS.md への申し送りを推奨する(下記)。

---

## 重点1: outcome-only mix と train_step ガードの等価性(コードパス精査)

**結論: 全既存 mix で厳密等価(SHA smoke に依存しない静的な保証がある)。**

- `Mix::coefficients(has_outcome)` の返す teacher_weight を全ケース列挙した:
  - teacher-only: (1.0, 0, 0) / outcome欠落時も `mix.outcome == 0.0` 分岐で (1.0, 0, 0)
  - baseline: (0.6, 0.3, 0.1) / 欠落時 (2/3, 1/3, 0)
  - no-ranking: (0.7, 0, 0.3) / 欠落時 (0.7/0.7=1.0, 0, 0)
  - **既存3 mixでは teacher_weight は常に非ゼロ** → 追加された `if teacher_weight != 0.0` ガード(`t090_distillation.rs:676`)は常に真で、修正前と同一の演算列(add_gradient の呼び出し順・浮動小数点演算順)を通る。ビット単位で等価。1epoch smoke の SHA-256 一致(`a9f60406...`、T095/T109/T110 記録値と同一)はこの静的結論の追認であり、等価性は smoke の被覆範囲に依存しない。
- outcome-only × outcome有り局面: coefficients=(0,0,1.0)。teacher 項の add_gradient はガードで飛ぶが、旧挙動でも scale=0.0*g=0.0 のエントリを作るだけで、outcome 項(`:710`)が**同一の `parent_features` キー集合**に勾配を加えるため、gradient マップのキー集合・値とも修正前後で一致する。**outcome有り局面の挙動は修正で一切変わっていない**(0.0*g が NaN になり得るのは g が非有限のときのみで、Huber 勾配は ±4 にクランプされるため発生しない)。
- outcome-only × outcome欠落局面: coefficients=(0,0,0)。ranking は `ranking_weight > 0.0` ガード(既存)、outcome は `record.outcome` の Some ガード(既存)で飛び、teacher が新ガードで飛ぶため gradient マップは空、返り値 loss は厳密に 0.0。**完全 no-op が構造的に保証される**。回帰テスト `train_step_is_a_full_no_op_...` が `to_bytes_v3()` バイト列不変で直接固定しており適切。

## 重点2: 「teacher_weight=0 でも L2 減衰がかかる」既存副作用の分析の妥当性

**結論: ワーカーの分析は正確。かつ「既存」といっても実害は outcome-only 以前には発生し得なかった。**

- 旧コードでは無条件 `add_gradient(scale=0.0)` が gradient マップに value=0.0 のエントリを作り、末尾ループ `*weight -= lr*(value + l2**weight)`(`:716-719`)が当該局面の触れた特徴に純粋な L2 減衰(lr*l2*w)を適用する — 分析どおり。
- ただし teacher_weight==0 になるのは outcome-only(または将来の teacher=0 mix)のみで、**既存3 mix ではこの経路は到達不能**。したがって「既存 mix に影響しない修正」という整理も正しい。
- 逆方向(outcome有り局面の挙動変化)が無いことは重点1のとおり確認済み。
- 軽微な注意: テスト専用のアドホック mix(`pairwise_huber_...` の teacher=0/ranking=1.0)は修正でL2挙動が変わり得るが、当該テストは l2=0.0 なので影響なし(確認済み)。

## 重点3: M1' 修正(ensure_metrics_header → truncate_metrics_after)の正しさ

**結論: 正しい。成功経路は順序交換で挙動同一、拒否経路は metrics.tsv について副作用フリーになった。**

- 成功経路(ヘッダ一致): `ensure_metrics_header` は読み取りのみ → `truncate_metrics_after` の出力は順序交換前と同一。ファイル欠如時は ensure がヘッダのみ作成 → truncate がそれを同内容で書き戻す(旧順序: truncate no-op → ensure 作成。終状態同一)。
- 拒否経路(ヘッダ不一致): ensure が読み取りのみで `Err` を返し、truncate に到達しない。回帰テスト `run_one_rejects_stale_header_before_truncate_mutates_the_file` がファイルバイト列の前後一致で固定しており、T110 指摘 M1' の要求(拒否時にファイルへ触れない)を満たす。
- truncate 側も、不正な epoch フィールドで `Err` する場合は `atomic_write` 前に return するため部分書き込みは起きない(既存挙動、確認のみ)。
- **軽微な残存**: `run_one` は header 検証より前に `identity.txt` を `atomic_write` する(`:966`)。identity 一致+ヘッダ不一致のケースでは同一バイトの書き戻し(mtime 更新)、identity 未存在なら新規作成が拒否経路でも起きる。M1' のスコープ(metrics.tsv)外の既存挙動であり退行ではないが、「拒否経路の完全な副作用フリー」ではない点は記録しておく。

## 重点4: 実験結論に影響しうるバグの有無(outcome-only の学習内容・early stopping・スキップ件数)

**結論: バグなし。outcome-only の学習は意図どおり「outcome Huber(δ=4)のみ」。**

- train_step: 重点1のとおり、outcome有り局面では勾配は outcome Huber 項のみ、loss も outcome 項のみ。
- **early stopping / モデル選択の指標**: best epoch 選択・stale 判定は `validation_metrics.mixed`(`metrics()` の mix 係数付き混合損失)で行われる。outcome-only では mixed = Σ(outcome Huber loss) / 全validation件数(2,363) — outcome欠落の480件は係数(0,0,0)で寄与0。分母が固定定数のため、これは**outcome有り局面の平均 outcome Huber 損失の単調変換**であり、モデル選択は純粋に outcome 損失基準で行われている。作業ログの説明(teacher_mae 列は参考値、選択は validation_loss=outcome項のみ)は正確。
  - 注意(軽微): patience 閾値 0.02 は絶対値のため、損失スケールが大きい outcome-only では相対的に緩く、mix 間で「同じ強さの early stopping」ではない。これは既存 ablation(T090b)から続く設計特性で、mix ごとに自分の validation 損失で選択するのは対照実験として妥当。
- **スキップ件数 8,924 の妥当性**: 45,055 − 36,131 = 8,924。outcome付与は `load_corpus`(source=="wthor" かつ outcomes map に一致)、outcomes map は `load_outcomes` で 2015-2023 集約から 2024 出現キーを除外して構築(`:432-437`) — **T090b redo#1 の manifest 実測値(outcome matches = 36,131 / 1,883 / 2,063)と完全一致**しており、コード・既存記録の双方と整合。タスク文の「65/50,000」が旧ポリシー(2024重複除外導入前)の値であるというワーカーの説明も T090b 作業ログ(§中1: 年代分離の導入)と整合する。
- train_loss ログ値が no-op 局面込みの件数(45,055)で割られるため希釈されるが、表示のみで学習・選択に影響しない(軽微)。

## 重点5: 比較の公平性と交絡

### 45k 同一集合内の比較(outcome-only vs no-ranking / teacher-only / baseline)— 概ね公平

同一 corpus(split 45,055/2,363/2,582 が T090b 実測と一致。タスク仕様の「45,058」は T109 仕様から伝播した誤記で、T090b 作業ログの実測は 45,055)、同一 split 関数、同一 max_epochs=60(T090b redo1 コマンドも `--max-epochs 60`)、同一 l2=1e-5、同一 LR スケジュール(0.005 起点・半減・MIN_LR)、同一ゼロ初期化・pattern-set v2。**トレーナー内の条件は揃っている。**

**[中1] ただし「同一局面集合でラベルだけ入れ替えた」は約80%しか真でない(結論の限定条件として明記すべき)**: outcome-only が実際に学習する局面は 36,131 件で、除外される 8,924 件(19.8%)は**ランダムではなく「2024年の対局にも出現する canonicalKey」= 頻出の序中盤局面に系統的に偏る**(2024重複除外ポリシーの構造上の帰結)。ゼロ初期化のモデルでは、スキップ局面でしか出現しない特徴状態の重みは一切更新されず 0 のまま残る。したがって teacher-only(2.8)と outcome-only(3.6-3.8)の差は「ラベルの質」と「約20%の系統的カバレッジ喪失」の合成であり、作業ログの含意2(ラベルの質の序列)はこの交絡を含む。outcome-only が悪いという方向自体は覆らない(むしろ「実質36kのoutcome回帰では届かない」とより強く言える)が、teacher vs outcome のラベル質差の定量的解釈には留保が要る。

### v2×WTHOR(1.5667)との比較 — 交絡が多く「密度が主要因」の単独根拠にはならない

pattern_v2.bin の来歴(T083設計依頼書 §現状、`train_patterns.rs` の既定 `TrainConfig`)と本トレーナーの差分を列挙する:

| 軸 | v2×WTHOR(train_patterns) | 蒸留トレーナー(train_distillation) |
|---|---|---|
| 損失 | **MSE**(`Loss::Mse` 既定) | **Huber δ=4** |
| エポック | 固定20、early stopping なし、最終重みをそのまま採用 | 上限60+patience early stop+best validation選択 |
| LR | 0.005 固定(減衰なし) | 0.005 起点で半減スケジュール |
| サンプル | 約114万局面(T083記録。per-occurrence、頻出局面が出現回数分重み付く) | canonical一意局面(重複なし) |
| ラベル | 各対局の最終石差(1局ごと) | canonical平均outcome(複数対局の平均、ノイズ低減) |
| 年代 | **2015-2024(2024込み)** | outcomeは2015-2023かつ2024重複キー除外 |
| 局面分布 | 実戦全局面 | 教師コーパス選抜50k |
| split | 対局単位90/10 | canonicalKeyハッシュ%100 |

**[中2]** したがって「1.57 vs 3.6-3.8」の差には、局面数(密度)以外に損失族(MSE vs Huber)・学習スケジュール・出現頻度重み付け・ラベル構成・年代・局面分布の差が混入する。加えて T109 の既存結果(同一トレーナー内で 6.2k→45k のサブセット曲線が実質フラット、傾き -0.19石/log10・R²≈0.9%)は「トレーナー内では密度を上げても改善しない」ことを示しており、**密度単独犯説はクロストレーナー比較のみに依存している**。本実験から最も堅く言えるのは「45k(実質36k)の outcome 回帰(このトレーナー・この損失)では 1.57石級に遠く届かない」「同一集合内では teacher 項を含む構成ほど良い(ただし中1の交絡込み)」であり、「100万級 outcome 局面をこのトレーナーに入れれば 1.57 に届く」ことは未検証。作業ログの含意3(密度が主・ラベル質が副の複合)は結論として妥当だが、上記の限定条件(中1・中2)を添えて申し送りすることを推奨する。

---

## 指摘一覧

### 重大(実験結論を覆しうる) — なし

### 中

- **[中1] outcome-only の実効学習集合は 36,131 件で、除外 8,924 件は 2024 年出現キー(頻出局面)に系統的に偏る。**「同一局面集合・ラベルのみ入替」という対照設計の純度は約80%であり、teacher-only との序列比較(含意2)にはカバレッジ喪失の交絡が乗る。結論の限定条件として STATUS.md/後続タスクへ申し送り推奨(コード修正は不要。ポリシーの構造上の帰結)。
- **[中2] v2×WTHOR(1.5667)との比較は密度以外に少なくとも6軸の交絡**(損失 MSE vs Huber δ=4 / 固定20epoch vs early stop+best選択 / LR固定 vs 半減 / per-occurrence重み付け vs canonical一意 / 1局outcome vs canonical平均 / 2024込み vs 除外、加えて局面分布・split方式)。T109 のトレーナー内フラット曲線とあわせ、「密度が主要因」はクロストレーナー比較由来の推定であることを明記して扱うべき。

### 軽微

- **[軽1]** `run_one` の拒否経路(ヘッダ不一致)でも `identity.txt` の atomic_write(同一バイトの書き戻し/未存在なら新規作成)は header 検証より先に起きる。M1' のスコープ(metrics.tsv)は満たしており退行ではないが、拒否経路の完全な副作用フリー化は未達。
- **[軽2]** early stopping の patience 閾値 0.02 が絶対値のため、損失スケールの異なる mix 間で停止強度が非対称(既存設計の継承。mix ごとの自己基準選択としては妥当)。
- **[軽3]** outcome-only の train_loss ログ値は no-op 局面込みの分母(45,055)で希釈される(表示のみ、学習に影響なし)。
- **[軽4]** タスク仕様の「train split 45,058」は誤記(T090b 実測・T109 実測・本タスク実測とも 45,055)。ワーカーの実測値が正。
- **[軽5]** `teacher_weight != 0.0` の厳密浮動小数点比較は現状の名前付き mix(リテラル由来)では安全。将来 mix を数値指定で拡張する場合は 0 近傍の扱いを再確認のこと。

## 確認した検証エビデンス(記録との突合)

- smoke SHA-256 `a9f60406...` は T095/T109/T110 の3タスクの記録値と一致(既存 mix 等価の実測面)。
- outcome 一致件数 36,131/1,883/2,063 は T090b redo#1 manifest 記録と完全一致。
- T090b 既存重み(no-ranking/teacher-only)の学習条件(max-epochs 60・corpus_primary・v2)は T112 outcome-only run と同一系(公平性確認)。
- 新規テスト4件はそれぞれ修正点(係数規約・no-op・M1'順序)を直接固定する適切な回帰テスト。
