# T165 canonical全量再学習 — 最終レビュー(Claude代替、Codex usage limit中)

- 対象: コミット `0645702`(前提修正2件: engine/src/pattern_eval.rs +54、train/src/bin/train_patterns_v3.rs +38/-7)、`52c6285`(bench/edax-compare/t165_training_report.md +164、同.meta.json +142)
- レビュー方法: 差分精読 + 現行コードとの突き合わせ + **成果物の独立検証**(候補3つ+現行本番`pattern_v4.bin`のSHA-256とマジックバイトを実測、9runのresults-earlystop.tsv・metrics.tsv・feature-distribution.json・実行ログのタイムスタンプを直接確認)+ 事前登録規準のgit履歴監査(起票コミット`9443041`とHEADのタスクファイルdiff)。テストコマンドの実行はverifier担当(本レビューは静的+成果物照合)。
- 前提: tasks/review/T164-canonical-retrain-wiring-claude-review.md(申し送り6件)。

## 総合判定: **合格**(重大指摘なし。中1件はレポート表の事前登録項目からのval_mae列欠落で、選定・manifestには影響しない。done判定は妨げない)

---

## 1. 前提修正2件の質(観点1)

### 修正1: to_bytes_v5/to_bytes_v3のscalar空assert — 良好

- **assert配置は正しい**: `to_bytes_v5`(engine/src/pattern_eval.rs:537-540)は既存のcanonical必須assertの後、`to_bytes_self_describing`委譲の前に`scalar_feature_weights.is_empty()`を検査。`to_bytes_v3`(同:513-516)も同型。`to_bytes_self_describing`がscalarブロックを一切書かない共通本体である以上、両者が同じ穴を持つという「対称性のためのスコープ拡張」判断は妥当(T164レビュー軽微2の指摘はv5のみだったが、v3への拡張理由もコメント・作業ログに明記されている)。
- **should_panicテストの実効性 — 有効**: 2件とも「assertを外したらテストが落ちる」構造になっていることを確認した。
  - `t165_to_bytes_v5_panics_for_canonical_model_with_scalar_features`は`zeroed_canonical(...).with_zeroed_scalar_features()`(B3-canonical相当)を構築するため、v5の第1assert(canonical必須)は**発火し得ず**(canonical_tablesは`Some`)、パニックは新設のscalar assertからしか出ない。仮に新assertが無ければ`to_bytes_v5`は黙って成功し(scalar落ち)、should_panicテストは失敗する。つまりテストは新ガードの存在を直接検証している。
  - v3側も同様: レガシーモデル(`zeroed_with_stage_definition`)+scalarなので第1assert(canonical禁止)は満たされ、新assertのみが発火経路。
  - ニット(指摘に含めず): `expected = "to_bytes_v5"`という部分一致文字列は同関数の2つのassertメッセージ両方に含まれるため、期待文字列としてはやや弱い(`"scalar特徴を持たないモデル専用"`まで指定すればどのassertが発火したか一意に固定できた)。ただし上記のとおり本ケースでは他方のassertが構造的に発火不能なので、実効性は損なわれていない。既存T163/T164のshould_panicテストと同じ流儀でもある。
- **既存呼び出し元への影響なし**: `to_bytes_v3`の全呼び出し(t088_experiment/t090_distillation/train_patterns_v3のserialize_model・テスト群)をgrepで確認。`serialize_model`は(canonical, scalar空)の全域マッチでscalar空のときだけv3/v5に振るため正常系で発火せず、t088/t090はscalar特徴を持たないレガシーモデルのみ。作業ログのテスト集計(engine 235→+2、train 139)とも整合し、退行の兆候なし。

### 修正2: write_feature_distributionのsplit_label引数化 — 概ね良好、ただし1箇所に新たな誤記(軽微1)

`&'static str`固定→`String`+引数化の設計は適切。4呼び出し箇所のラベルをコードの実データと突き合わせた:

| 経路 | 渡されるサンプル | ラベル | 正確性 |
|---|---|---|---|
| WTHOR 非ES(main、:1822) | `full_train_samples`(train対局のみ、subset前) | "WTHOR train games before optional stratified subset" | **正確**(元の文言が本来正しかった場所) |
| WTHOR ES(run_early_stop_wthor、:1473) | `full_train_samples` = `es_train_games`のflatten(val分離後・subset前) | "WTHOR early-stop train split (train games only, before optional stratified subset)" | **正確** |
| simple 非ES(main、:1717) | `split_by_position_hash`のtrain側 | "simple-corpus train split (position-hash split)" | **正確** |
| simple ES(run_early_stop_simple_corpus、:1359) | `split_for_early_stop(pool, val_percent)`の**train側**(val・frozen分離**後**) | "simple-corpus early-stop train split (position-hash split, **before validation split**)" | **不正確** |

軽微1: simple ES経路のラベル末尾「before validation split」は誤り。渡している`train_samples`は`split_for_early_stop`の戻り値のtrain側であり、**validation split・frozen splitを分離した後**のデータ(train/src/bin/train_patterns_v3.rs:1332-1333→1359-1362)。「WTHOR側の"before optional stratified subset"」に引きずられた文言と推測されるが、simple経路にsubset段は存在しない。正しくは「train split (position-hash split, **excludes** validation/frozen splits)」相当。実データ(T165構成B/Cのfeature-distribution.json、count=21,210,114=train_samples)は正しく、ラベルだけの誤記であり下流にこの文字列をパースするツールは無いが、**「ラベルの誤記を直す」という修正自体が新たなラベル誤記を1つ持ち込んだ**点は皮肉であり、次にこのファイルを触るタスクで直すべき。

## 2. レポートの方法論 — 事前登録規準の遵守(観点2): 守られている(事後変更の形跡なし)

git履歴とファイルシステムの両面から監査した:

- **規準は結果より前に確定**: 「事前登録の判定・選定規準」節は起票コミット`9443041`(07-21 07:18)に完全な形で存在し、`git diff 9443041 HEAD -- tasks/T165-*.md`は**作業ログの追記のみ**(規準・受け入れ基準・レポート仕様の変更ゼロ)。
- **実行はその後**: 実行ログ(train/data/t165/logs/)のmtimeで、最初のrun(A seed1)開始が07:34:21、9run目完了が09:07:38。全runが規準確定(07:18)と前提修正コミット(07:33:45)の後。ログの並びは逐次実行(重なりなし)とも整合し、決定性rerun(08:16-08:29)はB完了後・C開始前に挟まっており作業ログの記述と一致。
- **規準1(seed選定=frozen MAE最小)**: 3構成とも厳密最小で選定(A=seed2、B=seed3、C=seed1)、タイ無し。results-earlystop.tsvの実データ9行を照合し、レポート表・作業ログ・.meta.jsonの数値と**完全一致**。なおA seed2とseed3の差は5e-6石で実質的にはノイズ未満の同値だが、事前登録ルール(厳密比較、タイは小seed)を機械的に適用しており、仮にタイ扱いでもseed2が選ばれるため選定は頑健。
- **規準2(構成間比較無効の明記)**: レポート本文・meta双方に明記あり(後述4節)。
- **規準3(健全性チェック)**: 全9runぶんの記録あり、「数十局面」の規準に対し439-440局面/runで超過達成。val_mae推移の主張(A: 14.3-15.0台等)をmetrics.tsv実物でスポット確認し一致(A seed2はepoch6に15.011への一時スパイクがあるが回復しており「発散なし」の判定は妥当)。
- **規準4(決定性=B seed1のみ)**: 規準どおりの縮退範囲で実施。rerunログ(B-egaroucid-v4-seed1-rerun.log)が原ログと**同一バイト長(3,564)**で残っており、val_mae推移完全一致の主張を裏付ける。
- **唯一の逸脱(中1)**: タスクファイルのレポート仕様は「9runの表(epochs_run/best_epoch/**val_mae**/frozen_mae/所要時間/重みSHA-256)」と事前登録していたが、レポート・meta双方の表に**val_mae列が無い**(frozen_mseで代替)。best_val_maeは各runのmetrics.tsv末尾に存在する(例: A seed2=14.287802、C seed1=4.900527)ので隠蔽ではなく転記漏れであり、選定(frozen MAE基準)にもmanifestにも影響しない。ただし「事前登録した仕様から黙って変えない」という本タスクの規律そのものに関わるため、1行の補遺(または STATUS.md への申し送り)で記録することを推奨する。

## 3. 統計・数値の妥当性(観点3)

- **構成A 15.733の対過去v4系(T158b: B0=15.952、B3=15.890)の解釈**: 両者のfrozen母集団は**同一**である(WTHOR 74,024局・末尾10%=7,402局ホールドアウトの同一規約。T158b full runはtrain 66,622局/frozen 7,402局、T165 Aの`run_early_stop_wthor`も`round(74024*0.1)=7402`で同じ分割)。したがってこの比較は構成間比較(規準2)とは異なり**母集団としては比較可能**だが、改善幅約-0.22石の帰属は少なくとも3要因が交絡する: (i) canonical化(D4バグ修正による実質的なパラメータ共有の変化)、(ii) **早期打ち切り**(T158bは固定20エポックの最終エポック、T165はvalベストエポック選択。A seed2はbest_epoch=4で、20エポック時点の過学習を避けた効果が大きい可能性が高い)、(iii) val 5%(約19.9万サンプル)が学習から抜けた分(こちらは通常マイナス方向なので、改善を説明する交絡ではなく改善を過小評価させる向き)。**レポートはこの歴史比較に一切触れていない**。誤った主張はしておらず(事前登録が「frozen MAEでの採否判定をしない」である以上、沈黙は規律的とも言える)、選定にも影響しないが、「同じWTHOR frozenのMAE」として過去レポートと数字を並べ得る読者が canonical化の寄与と単純に読む危険は残る。T166レポートを書く際にこの交絡(特に早期打ち切りの寄与)を1段落で明記することを推奨(軽微2)。
- **Egaroucid構成のMAE 4.7-4.8がWTHORと比較不能である旨**: **十分に記載されている**。本文「事前登録の判定・選定規準の適用結果」2項が母集団・分割方式(対局単位vs局面ハッシュ)・データ規模・ラベル生成(WTHOR石差 vs Egaroucid自己対戦)の相違を挙げて横並び比較を無効と明言し、さらに「val/frozenの経路差についての注記」節がB/Cの局面単位分割による**リークバイアスで見かけ上小さく出やすい方向**まで正しく述べている(T164レビュー申し送り1・2に完全対応)。meta.jsonにも`crossConfigComparison.valid: false`が構造化されて残る。
- **数値の独立検証**: 候補3つの`.bin`のSHA-256とマジック(PWV5/PWV5/PWV6)、現行本番`pattern_v4.bin`(PWV3、`c372b833...`)を実測し、manifestと**全て一致**。9run表もresults-earlystop.tsv実物と全行一致。所要時間の記載もログmtime差と整合(例: B seed3は08:01:10→08:15:49≒14分39秒 vs 記載「約14分35秒」)。

## 4. 使い捨て健全性テスト方式の監査可能性(観点5、T164レビュー軽微5と同型) — 許容(軽微3)

- `engine/tests/t165_health_check.rs`は削除済み(現存しないことを確認)。T164スモークと同じく、(i) D4対称不変・finite等の恒久性質テストは`pattern_eval.rs`/`regression.rs`に存在する、(ii) 検査対象の実成果物(9つの`.bin`)は**ディスクに現存しSHAがレポートに確定している**(本レビューで実測一致を確認)、(iii) 手法(from_bytes→自己対戦40局から6手ごとサンプル→全8対称score一致〈誤差<1e-2〉+全係数finite走査)がレポート・作業ログに再実装可能な粒度で記録されている、の3点から参考実証として許容できる。
- ただしT164の時と比べ、今回は健全性チェックが**事前登録された足切り規準(規準3)の証跡**である点で監査上の重みが一段高い。弱点: (a) 自己対戦サンプリングのseedが未記録で、局面集合の厳密再現はできない(統計的再現のみ)、(b) 許容誤差1e-2はcanonicalスキームが本来保証する厳密一致(T163性質テストは完全一致)より緩い。同型の指摘が2タスク連続(T164軽微5→本件)なので、**都度書き捨てるのではなく`#[ignore]`付きの恒久監査テスト(重みパスを環境変数で受ける)として1本コミットしておく**ことを次回以降の標準とすることを推奨。
- なお決定性rerunディレクトリの削除は問題ない(rerunログ自体はlogs/に保全されている)が、gitignore領域の成果物を気軽に消す運用は候補`.bin`にとってはリスク(→申し送り(b)末尾)。

## 指摘事項

### 重大(ブロッカー): なし

### 中

1. **レポート表から事前登録項目のval_mae列が欠落**(2節): タスクファイルのレポート仕様「(epochs_run/best_epoch/val_mae/frozen_mae/所要時間/重みSHA-256)」に対し、md・meta双方の表がval_maeを持たずfrozen_mseで代替。選定はfrozen MAE基準なので結果・候補・manifestには無影響で、データはmetrics.tsvに現存(隠蔽ではない)。ただし「事前登録から黙って変えない」規律の観点で記録を要する。1行補遺またはSTATUS.md申し送りで足りる。**done判定は妨げない**。

### 軽微

2. simple-corpus ES経路のfeature-distributionラベル「before validation split」が事実と逆(実データはval/frozen分離後のtrain split)。ラベル誤記修正タスクの中で新たに持ち込まれた誤記(1節、実害なし・次回修正推奨)。
3. レポートが構成A(15.733)と過去v4系(T158b B0=15.952、**同一frozen母集団**)の比較可能性・交絡(canonical化/早期打ち切り/val 5%除去)に触れていない。誤記載ではなく欠落。T166レポートで1段落の注記を推奨(3節)。
4. should_panicテストのexpected文字列が関数名のみで、発火assertを文言レベルで特定しない(構造上は実効性あり、既存流儀とも整合。1節ニット)。
5. 健全性チェックの自己対戦サンプリングseed未記録+許容誤差1e-2が恒久テストの厳密一致より緩い。使い捨て方式は2タスク連続なので`#[ignore]`恒久ハーネス化を推奨(4節)。

## 5. T166(対局ゲート)への申し送り(観点4)

### (a) 対局設計の論理構造 — 「各候補vs現行v4」の直接対決3ペアリングは**必要条件の検定としては足りるが、それだけでは不十分になり得る**

- 採用判定は2段の論理でできている: 【ゲート】各候補が現行v4を置き換える価値があるか(候補ごとに独立の帰無仮説)と、【選抜】合格者が複数のとき何を本番にするか。3ペアリング(A vs v4、B vs v4、C vs v4)は前者を過不足なくカバーするが、後者は「対v4のマージン」の横並び比較になり、マージンの推移律は保証されない(特にB/CはEgaroucid自己対戦分布で学習しており、v4を直接対決で攻略しやすい/しにくいという相手固有効果が乗る)。
- **推奨は既存プロトコルの踏襲**: T125/T158dで確立した「対Edax(共通外部対戦相手)・同一opening 30ペア・paired bootstrap」方式を主計測にする。共通openingで4者(v4+候補3)を各60局対Edaxで走らせれば、(i) 各候補vs v4のゲート判定(opening単位のpaired差)、(ii) 候補間の選抜(同じopening・同じ相手なのでpaired比較が候補間でも成立)が**同一データで両方**得られ、候補間直接対決を追加せずに済む。コストは4×60局≒55分(T158d実測13-14秒/局)。直接対決(候補vs v4のエンジン同士)を採る場合は、3ペアリングで合格者を出した後、合格者が2つ以上のときのみ合格者間の追加ペアリングを遅延実行する2段設計を**事前登録**すること。
- いずれの設計でも、局数・opening集合・Edaxレベル・判定規準(例: paired差CIが悪化を除外/勝率規準)・複数候補による選択バイアスの扱い(3仮説の多重性)を**T165と同様に走らせる前にタスクファイルへ事前登録**すべき。

### (b) PWV5/PWV6重みが対局経路で読めるかの事前確認

- 経路自体は対応済みのはず: `eval_cli`は`load_pattern_weights`(engine/src/bin/eval_cli.rs:69-88)で`PatternWeights::from_bytes`(マジックディスパッチ、T163/T164でPWV5/PWV6対応・テスト済み)を使い、vs_edax.pyは`--pattern-weights`で任意パスを渡すだけ(:393-394, 423-424)。scalar特徴は**既定で有効**であり、無効化フラグ`--disable-eval-features`をvs_edax.pyは渡していない → 候補C(PWV6)は学習どおりscalar有効で対局する。
- **事前確認としてやるべきこと**: 対局開始前に候補3ファイルそれぞれで`eval_cli best`を1局面実行し、(i) パース成功、(ii) stderrの`[eval_cli weights] scalar_features_present=... scalar_features_enabled=...`が候補A/Bで`false/false`、候補Cで`true/true`であることを確認し、T166メタデータに記録する。なお`eval_cli`にはPWV1-PWV3限定をassertするサブコマンドが1つある(:126-128の変換系)が、対局経路(gen/apply/moves/best)ではない。
- 付随の注意2件: (1) WASM側はPWV5/PWV6**未対応のまま**(T164レビュー申し送り6)。ネイティブの対局ゲートには影響しないが、勝者の本番配線タスクでは必須作業になる。(2) 候補`.bin`はgitignore領域(train/data/t165/)にあり保護されない(本タスク内でもrerun-checkディレクトリが確認後即削除されている)。vs_edax.pyがweightsSha256を記録するため取り違えは検出されるが、**T166完了までt165ディレクトリを消さない**こと、できれば候補3ファイルを退避コピーしておくことを推奨。

### (c) T158d v4 baseline 60局の再利用可否 — **推奨: 再利用せず、現行バイナリでv4 baselineを再実行する(コスト約14分)**

- まず前提の訂正: 「レガシー経路ビット不変 → v4側の対局結果は理論上同一になるはず」は**成立しない**。vs_edax.pyの対局は`--engine-time-ms 1500`の**実時間予算**を含む探索であり(T158d設定: depth 12/exact 16/max_nodes 160k/time 1500ms)、同一バイナリでも実行ごとの到達ノード数・着手が保証されない。ビット不変が保証するのは評価関数の出力(固定深さ・固定ノードの決定性系列)までで、時間管理下の60局のゲーム系列は理論上同一にならない。SHA厳密主義(evalCliSha256の一致)以前に、時間依存の対局層はそもそも再現単位ではない。
- 次に前例: T158d自身が、T125時点のv4 60局(バイナリSHA相違)を**参考数値扱いに格下げし、paired比較用のv4はその場で再実行**している(t158d_report.md: 「エンジンバイナリはT125時点のものでSHAが異なる」注記付きの参考行)。T166がT158d v4を流用すると、この確立済みの規律から後退する。
- コスト: T158d実測でv4 60局=816秒≒**14分**。候補3×60局(約40分)に対する追加25%であり、paired設計の妥当性(同一バイナリ・同一実行環境での対発生)を買う対価として安い。ベンチ再実行抑制方針(2026-07-14)は「汚染されていない既存結果の再検証をしない」趣旨であり、ここでの再実行は再検証ではなく**新しい比較のための対照群の同時生成**なので方針と矛盾しない。
- どうしても流用する場合の縮退案(非推奨だが許容): T158dのv4結果をそのまま対照に使い、(i) レポートに新旧evalCliSha256の両方と「レガシー経路ビット不変はT163/T164のstash検証で担保、ただし対局層は時間依存」の注記を明記、(ii) 現行バイナリ+pattern_v4.binで**fixed-depth決定性系列**(vs_edax.pyに既設、T158dで40/40 PASSED)を再実行しT158d記録値との一致を確認して経路不変を実証的に補強する。この場合、candidate側とv4側で実行時期・環境負荷が異なるpaired比較になる限界を判定文に残すこと。
