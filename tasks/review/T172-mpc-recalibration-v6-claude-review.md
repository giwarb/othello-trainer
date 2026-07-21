# T172 最終レビュー(Claude代替レビュー、Codex usage limit中)

- 対象: コミット `910235b`(engine,bench: MPCをv6評価関数で再校正、Gate 2合格/Gate 3不合格で事前登録どおり撤退(T172))
- タスク: `tasks/T172-mpc-recalibration-v6.md`
- 前提資料: tasks/T156a〜d、tasks/design/T156-mpc-recalibration-report.md、tasks/review/T156d-mpc-ab-gates-codex-review.md、bench/edax-compare/t156_mpc_gates_report.md
- レビュー方法: 差分精読(mpc.rs / compare_mpc.py / test_compare_mpc.py / t172_sigma_compare.py / t172_build_report.py)、レポート・meta実データとの突合、独立再計算(下記)、テスト実行(下記)

## 実施した独立検証(レビュー時に実行)

1. `python -B -m unittest discover`(test_compare_mpc.py): **10 passed**(canonical 4入力それぞれの1バイト改変拒否subtestを含む)。
2. `python bench/edax-compare/t172_sigma_compare.py --self-test`: passed。
3. `cargo test -p engine --lib`: **240 passed / 0 failed / 2 ignored**(作業ログの記載と一致)。
4. `train/weights/pattern_v6.bin` の実SHA-256 = `e69f3b1c...caf20fc9` が `EXPECTED_WEIGHTS_SHA256` と一致することを実測確認。
5. CALIBRATIONS表の独立再導出: `t172_sigma_compare.meta.json` のv6 slope/intercept/residualSigmaから `slope_q16=round(slope*65536)`・`intercept_q16=round(intercept*65536)`・`margin=ceil(1.5σ)` を再計算し、(d,D)=(3,6)×4帯の4行でコミット済みmpc.rsの値(62870/-16136717/425 等)と**厳密一致**。margin列は16行全て(σ表×1.5のceil)で一致。
6. T156d(v4)実測値との突合: T172レポートが引用するv4値(Gate 2 D8/10/12=0.8278/0.6025/0.4348、Gate 3 +1率5.83%・regret+0.1833・paired U95+0.6167)は `t156_mpc_gates_report.md`・T156d作業ログの数値と完全一致。bootstrap seed 156004・samples 100000もT156dと同一。

## 観点別評価

### 観点1: 方法論の同一性(測定深さの絞り込み・判定線の事後変更有無)

**問題なし。**

- 深さ絞り込みの妥当性: 候補4ペア(3,6),(4,8),(2,10),(4,12)が必要とする深さ集合は正確に{2,3,4,6,8,10,12}であり、測定深さと過不足なく一致。かつ `t156_mpc_stats.py` の群別affine回帰は各(bucket,d,D)ペアのshallow/deep対のみから計算されるため、**未使用深さの省略は候補16群の統計値に影響し得ない**(方法論的に同一)。同一320局面pilot corpusであることは `t172_sigma_compare.py` の positions fingerprint 一致チェック(不一致でValueError)で機械保証されている。
- ただし深さを絞った帰結として「v6での(d,D)候補の再選定」は構造的に不可能になっている。これはスクリプトdocstring・作業ログで明示的に開示され、再評価条件「(d,D)ペア再選定・帯結合見直し」として記録済み(観点4参照)。意識的なスコープ判断として妥当。
- 判定線の事後変更なしを確認: compare_mpc.py の差分は SHA定数更新+レポート文言のパラメータ化のみで、**gate2()/gate3()の判定ロジック・閾値には一切触れていない**。判定線(深さ+1到達率≥35%かつregret≤+0.10石、補助: paired U95≤+0.50石、浅化≤10%、4石loss増≤2/60局面相当、決定性、wall hit=0)は設計レポート§7・T156d(redo#1で確定したloss4文言の設計レポート優先解釈を含む)と同一。strictLoss4RateNoIncrease を "initial wording" として併記する扱いもT156d redoの決着どおり。
- Gate 3の計測条件(160k・quota60%・exact_from_empties=16・min_empties=21・t157 oracle 120局面・2回実行決定性)はmeta内 validatedCheckpoints の10 config を実際に読んで T156d と同一であることを確認。

### 観点2: CALIBRATIONS置換の安全性

**問題なし。**

- v4旧値の保存: (a) v4のslope/intercept/residualSigma/fitNが `t172_sigma_compare.meta.json` の各行に**数値として保存**されている(σだけでなく係数も)。(b) v4のfit元データ `t156_mpc_pilot_stats.json` はリポジトリに残存。(c) mpc.rsのモジュールdocがσ比較レポートとgit履歴を明示参照。git履歴「だけ」に頼る状態ではない。
- v4切り戻し手順: mpc.rsのdocに埋め込み式(slope_q16/intercept_q16/margin)が明記されており、`t156_mpc_pilot_stats.json`(または910235b直前のmpc.rs)から機械的に復元可能。「この表だけを同じ手順で差し替えればよい」の記述もあり手順は追跡可能。
- default OFFの構造確認: `SearchPolicy` の既定は `enable_mpc: false`(search.rs:504)、かつ実行時有効化は `policy.enable_mpc && (cfg!(feature = "mpc_enabled") || cfg!(test))`(search.rs:722)の二重ゲート。`mpc_enabled` featureはCargo.tomlのdefault featuresに含まれず、本番(wasm)ビルドは指定しない。**表の置換は本番経路の挙動に影響しない**ことを構造的に確認。`cargo test --lib` 240 passedで挙動不変も裏付け。

### 観点3: compare_mpc.py/test_compare_mpc.pyのv6対応がfail-closed検証を弱めていないか

**弱めていない。**

- canonical SHA検証4件(Gate 2 corpus・oracle positions・oracle labels・重み)はすべて `validate_inputs()` 先頭の到達可能位置に残り、**重みSHAはCLI引数化されず定数のまま**v6値に更新(ここをパラメータ化していたらfail-closedの弱体化だったが、そうしていないのは正しい判断)。パラメータ化されたのはレポートの表示文言(--weights-label/--report-title/--cause-analysis-file/--retreat-step-file/--analysis-label)のみで、判定・検証には無関係。
- T156d redo#2で追加された改変拒否回帰テストはfixtureをpattern_v6.binに更新のうえ維持され、実行して10件パス(4つのcanonical入力それぞれの1バイト改変が集計前に拒否されることを確認)。
- meta schema 2の監査情報(10 checkpoint分のconfig・positions/weights fingerprint・selected-ID fingerprint・レコード集合サマリ)も維持されている(実データで確認)。

### 観点4: 撤退判断の質

**妥当。事前登録どおりの撤退で、再評価条件は追跡可能。**

- 事実関係: 深さ+1到達率11.67%(<35%)・regret悪化+0.1333石(>+0.10)で主判定線2つとも未達、はmeta・レポート・コミットメッセージで一貫。補助基準(paired U95 +0.35≤+0.50)は今回クリアしたことも正しく開示されており、良い結果だけを強調する事後的な線引き変更はない。
- 再評価条件の具体性: 「(d,D)ペアの再選定・帯結合の見直し」「ノード予算拡大時の再評価」がレポート「原因分析と提言」と作業ログの両方に記録され、前者は観点1の「深さを絞ったため再選定不可」という本タスクの制約と正しく対応している。追跡可能。
- 原因分析の正しさ: レポートは「固定深さでの大幅なノード削減が、160kの反復深化では次の完成深さ到達という実利に変換しきれていない」「B-D(aspiration条件を揃えた対)で平均深さ差+0.108・regret差+0.0000であり、aspirationを外す損失をMPC単体で相殺できない構図はv4と同様」と記述。数値を検算すると B(9.000)-D(8.892)=+0.108、B(1.2833)-D(1.2833)=+0.0000 で正確。さらにレビュー側の裏取りとして、Gate 2のD10 MPC-onノード平均は 40,880,645/240 ≒ **170k/局面**であり、160k予算に対して「深さ10完成にわずかに届かない」水準にあることが確認できる。σ半減・Gate 2大幅改善(D12でノード比0.435→0.175)でもGate 3が動かない主因が「ノード予算の絶対量」側にあるという分析は、この定量関係と整合しており正しい。
- なお C構成(全ON、診断用)が regret 1.1500(Aと同一)・平均深さ+0.075 という結果は「MPC+aspiration併用なら regret 中立」を示唆するが、B を本番候補とする枠組みは T156 設計の事前登録であり、aspiration併用の再設計はタスクのスコープ外として明示されている。逸脱なし。

### 観点5: 次タスクへの申し送り(推奨)

以下をSTATUS.mdの申し送りに載せることを推奨する(レビューからの追加提案であり、コミットの瑕疵ではない):

1. **マルチスレッド(フェーズ7)は記録済み再評価条件「ノード予算拡大」に実質該当する。** 実効探索量が倍増すればGate 3再判定の価値がある。上記のとおりD10完成に必要なMPC-onノードは約170k/局面で160k予算のわずかに外側にあり、予算1.5〜2倍で深さ+1到達率が大きく動く可能性が定量的に示唆される。
2. **終盤速度パックも間接的にMPC再評価条件に効く**: Gate 3実測でexactノードは総予算の約41%を占めており、終盤高速化はミッドゲームに回る実効予算を増やす。マルチスレッド後にまとめて再評価するのが効率的。
3. v6用CALIBRATIONSはdefault OFFのまま本番に入っており、再評価時は再校正不要でGate 3再実測から始められる(σ・Gate 2は合格済み)。

## 指摘事項

### 重大(ブロッカー)

なし。

### 中

1. **レポート記載の再現コマンドが、レポート本文の完全再生成に対して不完全**(`t172_mpc_report.md` 再現方法節、`t172_mpc_gates_report.md` はカスタム題名・撤退文・原因分析で生成されている)。記載の compare_mpc.py コマンドには `--report-title`/`--analysis-label`/`--cause-analysis-file`/`--retreat-step-file` が含まれておらず、そのまま実行するとT156d既定文言のレポートが生成されSHAが一致しない(将来の監査者が「再現失敗」と誤解しうる)。**判定に関わるmeta(数値・合否・config・SHA・seed)はコマンドライン非依存で完全に再現可能**なため受け入れ基準3は満たしており、影響は報告書プローズの再現性のみ。対処案: 実際の全引数をmetaか作業ログに1行残す(次回スクリプト使用時で可、再コミット必須とまでは言わない)。

### 軽微

1. `compare_mpc.py` の `report()` 既定引数・`--weights-label` 既定値がT156d/v4固有のまま(`weights_label="v4"`、T156e言及の既定文)なのに対し、SHA定数はv6固定。引数を省略して実行すると「v6データをv4と表示する」不整合レポートが生成される潜在的footgun。SHAがfail-closedなので誤った重みでの実測は起きないが、次回の再校正時は既定値ごと更新するか必須引数化が望ましい。
2. `t172_sigma_compare.py` の self-test がユニットテストスイートに未登録(手動 `--self-test` のみ)。使い捨て分析スクリプトとしては許容範囲。
3. (d,D)候補はv4時代(T156b)の選定を引き継いでおり、v6でのペア最適性は未検証。開示・再評価条件記録済みのため指摘としては軽微(観点1・4参照)。

## 総合判定

**合格**(重大0・中1・軽微3)。中1件はレポート文面の再現手順の不完全さであり、判定の正しさ・metaからの計測再現性・事前登録判定線の遵守はすべて確認できた。Gate 3不合格→事前登録どおり撤退(MPC default OFF維持、T173へ進まない)という結論は妥当であり、doneとしてよい。中・軽微の指摘はSTATUS.mdへの申し送りで足りる(観点5の申し送り3点の記録を推奨)。
